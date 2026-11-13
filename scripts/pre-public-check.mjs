#!/usr/bin/env node
// Pre-public check: run it before a private repo is made public, and it runs
// by itself (.github/workflows/public-guard.yml) the moment the repo flips.
//
// It answers one question: is there anything on GitHub that must not be
// public? It checks what the remote holds, not the working tree:
//
//   refs        every branch and tag must be allowed (main, v* and node-v*
//               tags by default, more with --allow). Work-in-progress branches
//               (security/*, feature branches, tool checkpoints) must be
//               deleted first or named with --allow on purpose.
//   identities  every commit's author and committer address must be a GitHub
//               noreply address (a real name or a machine name in history is
//               public forever once it flips).
//   secrets     key and token shapes in any commit's added lines.
//   paths       files that must never be committed, anywhere in history.
//   terms       words from a private list (default assets/plans/private-terms.txt,
//               which is gitignored, so the list itself never ships), checked
//               in file content, commit messages and file names.
//   warnings    home-directory paths and personal email addresses in added
//               lines (history that was public before shows up here too).
//
// Exit 0 = nothing blocking, 1 = at least one failure, 2 = bad usage.
// It prints the rule, the commit and the file, never the matched secret.
//
//   node scripts/pre-public-check.mjs                run against origin
//   node scripts/pre-public-check.mjs --allow 'feat/*' --allow v0.9.0
//   node scripts/pre-public-check.mjs --local        use local refs, no network
//   node scripts/pre-public-check.mjs --no-fetch     use the remote-tracking refs as they are
//   node scripts/pre-public-check.mjs --terms <file>
//   node scripts/pre-public-check.mjs --allowlist <file>   default scripts/pre-public-check.allowlist.json,
//                                    reviewed { rule, file, reason } entries

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NOREPLY = /(@users\.noreply\.github\.com|^noreply@github\.com)$/i;

export const DEFAULT_ALLOWED_REFS = ['main', 'tags/v[0-9]*', 'tags/node-v*'];

const SECRET_RULES = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{16,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

const HOME_PLACEHOLDERS = /^(you|me|name|user|username|your-?name|example|someone|shared|public|default|gaffer|runner|\$\{?[A-Za-z_]+\}?|<[^>]*>|%[A-Za-z_]+%|\.\.\.|x+)$/i;
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([^\s/\\'"`:)\]]+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const EMAIL_OK = /(^|\.)(example\.(com|org|net)|users\.noreply\.github\.com|noreply\.github\.com|github\.com|anthropic\.com|localhost|test|invalid)$/i;

// Paths that must never exist in any scanned commit.
const FORBIDDEN_PATHS = [
  [/(^|\/)\.env(\.|$)/, 'environment file'],
  [/\.(pem|p12|pfx|key)$/i, 'key or certificate file'],
  [/(^|\/)chat-history[^/]*\.json$/, 'saved chat history'],
  [/(^|\/)\.gaffer-config\.json$/, 'per-install config'],
  [/(^|\/)\.remember\//, 'local session history'],
  [/(^|\/)assets\//, 'local-only asset store (licensed fonts, private plans)'],
  [/\.aep$/i, 'After Effects project'],
];

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout).trim());
  return r;
}

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[0-9\]/g, '[0-9]');
  return new RegExp('^' + esc + '$');
}

// Reviewed findings that are not leaks (a detector's own test strings, say).
// Each entry is { rule, file, reason }; a reason is required so the list stays
// an audit trail, not a mute button. The file lives in the repo on purpose.
export const DEFAULT_ALLOWLIST = 'scripts/pre-public-check.allowlist.json';

function loadAllowlist(cwd, path) {
  const f = path || join(cwd, DEFAULT_ALLOWLIST);
  if (!existsSync(f)) return [];
  const list = JSON.parse(readFileSync(f, 'utf8'));
  for (const e of list) if (!e.rule || !e.file || !e.reason) throw new Error('allowlist entry needs rule, file and reason: ' + JSON.stringify(e));
  return list;
}

export function runChecks({ cwd, local = false, fetch = true, allow = [], termsFile = null, allowlistFile = null } = {}) {
  const allowlist = loadAllowlist(cwd, allowlistFile);
  const allowlisted = (rule, file) => allowlist.some((e) => e.rule === rule && e.file === file);
  const failures = [];
  const warnings = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const warn = (rule, detail) => warnings.push({ rule, detail });

  // ---- which refs does GitHub hold ----
  let names;
  let scanRefs;
  if (local) {
    const out = git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']).stdout;
    const refs = out.split('\n').filter(Boolean);
    names = refs.map((r) => r.replace(/^refs\/heads\//, '').replace(/^refs\//, ''));
    scanRefs = refs;
  } else {
    const ls = git(cwd, ['ls-remote', '--heads', '--tags', 'origin']).stdout.split('\n').filter(Boolean);
    names = ls.map((l) => l.split('\t')[1]).filter((n) => !n.endsWith('^{}')).map((n) => n.replace(/^refs\/heads\//, '').replace(/^refs\//, ''));
    if (fetch) git(cwd, ['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']);
    scanRefs = git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin', 'refs/tags']).stdout
      .split('\n').filter((r) => r && r !== 'refs/remotes/origin/HEAD');
  }
  const allowed = [...DEFAULT_ALLOWED_REFS, ...allow].map(globToRegex);
  const isAllowed = (n) => allowed.some((re) => re.test(n));
  const stray = names.filter((n) => !isAllowed(n));
  for (const n of stray) fail('refs', (n.startsWith('tags/') ? 'tag ' + n.slice(5) : 'branch ' + n) + ' is not on the allowed list (delete it, or pass --allow)');
  if (names.length === 0) warn('refs', 'the remote lists no branches or tags');

  // Scan every ref present, allowed or not: a stray branch is deleted before
  // the flip, but a secret on it is still worth knowing about, and a rerun
  // after the deletion shows what is left.
  const refsToScan = scanRefs;
  if (refsToScan.length === 0) return { failures, warnings, commits: 0 };

  // ---- private terms ----
  let terms = [];
  const tf = termsFile || join(cwd, 'assets', 'plans', 'private-terms.txt');
  if (existsSync(tf)) {
    terms = readFileSync(tf, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((t) => t.toLowerCase());
  } else {
    warn('terms', 'no private-terms file at ' + tf + ' (one word or phrase per line); the term check did not run');
  }
  const hasTerm = (text) => { const low = text.toLowerCase(); return terms.find((t) => low.includes(t)); };

  // ---- identities and commit messages ----
  const idOut = git(cwd, ['log', ...refsToScan, '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e']).stdout;
  const ids = new Map();
  let commits = 0;
  for (const rec of idOut.split('\x1e')) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    commits++;
    const [hash, an, ae, cn, ce, body] = r.split('\x1f');
    for (const [name, email, role] of [[an, ae, 'author'], [cn, ce, 'committer']]) {
      if (!NOREPLY.test(email)) {
        const key = role + ' ' + email;
        const e = ids.get(key) || { count: 0, first: hash.slice(0, 8) };
        e.count++; ids.set(key, e);
      }
    }
    const t = hasTerm(body || '');
    if (t) fail('terms', 'commit message of ' + hash.slice(0, 8) + ' contains a private term (line "' + t.slice(0, 2) + '...")');
  }
  for (const [key, e] of ids) fail('identities', e.count + ' commit(s), first ' + e.first + ', ' + key.replace(/^(\w+) (.*)$/, '$1 address $2') + ' is not a GitHub noreply address');

  // ---- added lines, file names ----
  const patch = git(cwd, ['log', ...refsToScan, '-p', '--no-color', '--no-renames', '--format=C %H']).stdout;
  let commit = '';
  let file = '';
  const seen = new Set();
  const once = (rule, kind, text, extra) => {
    const key = rule + '|' + file + '|' + extra;
    if (allowlisted(rule, file)) return;
    if (seen.has(key)) return;
    seen.add(key);
    (kind === 'fail' ? fail : warn)(rule, text);
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('C ')) { commit = line.slice(2, 10); file = ''; continue; }
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      file = m ? m[1] : '';
      for (const [re, why] of FORBIDDEN_PATHS) if (re.test(file)) once('paths', 'fail', file + ' (' + why + ') appears in commit ' + commit, 'p' + why);
      const t = hasTerm(file);
      if (t) once('terms', 'fail', 'file name ' + file + ' in commit ' + commit + ' contains a private term', 'tn');
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const text = line.slice(1);
    for (const [rule, re] of SECRET_RULES) if (re.test(text)) once('secrets', 'fail', rule + ' shape in ' + (file || 'a file') + ', commit ' + commit, rule);
    const term = hasTerm(text);
    if (term) once('terms', 'fail', 'private term in ' + (file || 'a file') + ', commit ' + commit, 'tc');
    HOME_PATH.lastIndex = 0;
    let m;
    while ((m = HOME_PATH.exec(text))) {
      if (!HOME_PLACEHOLDERS.test(m[1])) { once('home-path', 'warn', 'a home-directory path naming a real account in ' + (file || 'a file') + ', commit ' + commit, 'h' + m[1]); break; }
    }
    EMAIL.lastIndex = 0;
    while ((m = EMAIL.exec(text))) {
      if (!EMAIL_OK.test(m[1])) { once('email', 'warn', 'an email address outside the allowed domains in ' + (file || 'a file') + ', commit ' + commit, 'e' + m[1]); break; }
    }
  }
  return { failures, warnings, commits };
}

export function format(result) {
  const out = [];
  const group = (title, items) => {
    if (!items.length) return;
    out.push(title);
    const byRule = new Map();
    for (const i of items) { if (!byRule.has(i.rule)) byRule.set(i.rule, []); byRule.get(i.rule).push(i.detail); }
    for (const [rule, details] of byRule) {
      out.push('  [' + rule + '] ' + details.length + (details.length === 1 ? ' finding' : ' findings'));
      for (const d of details.slice(0, 15)) out.push('    - ' + d);
      if (details.length > 15) out.push('    ... and ' + (details.length - 15) + ' more');
    }
  };
  group('FAIL', result.failures);
  group('WARN', result.warnings);
  out.push(result.failures.length ? 'RESULT: do not make this repository public (' + result.failures.length + ' failure(s)).' : 'RESULT: nothing blocking in ' + result.commits + ' commit(s)' + (result.warnings.length ? ', ' + result.warnings.length + ' warning(s) to read.' : '.'));
  return out.join('\n');
}

function main(argv) {
  const opts = { cwd: process.cwd(), allow: [], local: false, fetch: true, termsFile: null, allowlistFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') opts.local = true;
    else if (a === '--no-fetch') opts.fetch = false;
    else if (a === '--allow') { if (!argv[i + 1]) return usage(); opts.allow.push(argv[++i]); }
    else if (a === '--terms') { if (!argv[i + 1]) return usage(); opts.termsFile = argv[++i]; }
    else if (a === '--allowlist') { if (!argv[i + 1]) return usage(); opts.allowlistFile = argv[++i]; }
    else if (a === '--repo') { if (!argv[i + 1]) return usage(); opts.cwd = argv[++i]; }
    else return usage();
  }
  const result = runChecks(opts);
  console.log(format(result));
  return result.failures.length ? 1 : 0;
}

function usage() {
  console.error('usage: pre-public-check.mjs [--local] [--no-fetch] [--allow <ref-glob>]... [--terms <file>] [--allowlist <file>] [--repo <dir>]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
