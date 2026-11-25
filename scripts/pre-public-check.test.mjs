import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runChecks, format } from './pre-public-check.mjs';
import { tmpDir } from '../panel/daemon/test/tmp.mjs';

const SCRIPT = fileURLToPath(new URL('./pre-public-check.mjs', import.meta.url));
const NOREPLY = 'tester@users.noreply.github.com';

function sh(cwd, args, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env } });
  assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}

// A bare "origin" and a working clone with one clean commit on main.
function makeRepo() {
  const root = tmpDir('gaffer-public-check-');
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  mkdirSync(origin);
  sh(origin, ['init', '--bare', '-b', 'main']);
  mkdirSync(work);
  sh(work, ['init', '-b', 'main']);
  sh(work, ['remote', 'add', 'origin', origin]);
  commit(work, 'README.md', '# hello\n', 'initial');
  sh(work, ['push', 'origin', 'main']);
  return { root, origin, work };
}

function commit(work, file, text, msg, ident = NOREPLY) {
  const full = join(work, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  sh(work, ['add', '-f', file]);
  sh(work, ['commit', '-m', msg], {
    GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: ident, GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: ident,
  });
}

const check = (work, extra = {}) => runChecks({ cwd: work, fetch: true, termsFile: join(work, 'no-terms.txt'), ...extra });
const rules = (r) => r.failures.map((f) => f.rule).sort();

test('a clean repository with only main and version tags passes', () => {
  const { root, work } = makeRepo();
  try {
    sh(work, ['tag', 'v1.2.3']);
    sh(work, ['tag', 'node-v24.22.1']);
    sh(work, ['push', 'origin', '--tags']);
    const r = check(work);
    assert.deepEqual(r.failures, []);
    assert.ok(r.commits >= 1);
    assert.match(format(r), /RESULT: nothing blocking/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stray branch or tag fails until it is deleted or allowed on purpose', () => {
  const { root, work } = makeRepo();
  try {
    sh(work, ['push', 'origin', 'main:refs/heads/security/0.12.2-rc']);
    sh(work, ['tag', 'wip']);
    sh(work, ['push', 'origin', 'wip']);
    const r = check(work);
    const details = r.failures.filter((f) => f.rule === 'refs').map((f) => f.detail).join('\n');
    assert.match(details, /branch security\/0\.12\.2-rc/);
    assert.match(details, /tag wip/);
    const allowed = check(work, { allow: ['security/*', 'tags/wip'] });
    assert.deepEqual(allowed.failures, []);
    sh(work, ['push', 'origin', '--delete', 'security/0.12.2-rc']);
    sh(work, ['push', 'origin', '--delete', 'tags/wip']);
    assert.deepEqual(check(work).failures, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a commit whose author or committer is not a GitHub noreply address fails, naming the address and commit', () => {
  const { root, work } = makeRepo();
  try {
    commit(work, 'a.txt', 'a\n', 'host identity', 'someone@Machine.local');
    sh(work, ['push', 'origin', 'main']);
    const r = check(work);
    assert.deepEqual(rules(r), ['identities', 'identities']);
    assert.ok(r.failures.some((f) => f.detail.includes('someone@Machine.local') && /author address/.test(f.detail)));
    assert.ok(r.failures.some((f) => /committer address/.test(f.detail)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitHub web-flow commits (noreply@github.com) count as noreply', () => {
  const { root, work } = makeRepo();
  try {
    commit(work, 'a.txt', 'a\n', 'web merge', 'noreply@github.com');
    sh(work, ['push', 'origin', 'main']);
    assert.deepEqual(check(work).failures, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a key or token in any commit fails even if a later commit removed it, and the value is never printed', () => {
  const { root, work } = makeRepo();
  try {
    const key = 'sk-ant-' + 'abcdefghijklmnop1234567890';
    const gh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    commit(work, 'src/config.js', 'const k = "' + key + '";\nconst t = "' + gh + '";\n', 'oops');
    commit(work, 'src/config.js', 'const k = process.env.K;\n', 'remove it');
    sh(work, ['push', 'origin', 'main']);
    const r = check(work);
    assert.deepEqual(rules(r), ['secrets', 'secrets']);
    const text = format(r);
    assert.match(text, /anthropic-key shape in src\/config\.js/);
    assert.match(text, /github-token shape in src\/config\.js/);
    assert.ok(!text.includes(key) && !text.includes(gh), 'the secret itself is not in the report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('files that must never be committed fail, anywhere in history', () => {
  const { root, work } = makeRepo();
  try {
    commit(work, 'assets/plans/pricing.md', 'x\n', 'plans');
    commit(work, 'panel/chat-history-26.0.json', '[]\n', 'history');
    commit(work, 'deploy/server.pem', 'x\n', 'cert');
    commit(work, '.env', 'A=1\n', 'env');
    sh(work, ['rm', '-q', '-r', '--cached', 'assets', 'deploy', '.env', 'panel']);
    sh(work, ['commit', '-q', '-m', 'remove'], { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: NOREPLY, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: NOREPLY });
    sh(work, ['push', 'origin', 'main']);
    const details = check(work).failures.filter((f) => f.rule === 'paths').map((f) => f.detail).join('\n');
    assert.match(details, /assets\/plans\/pricing\.md/);
    assert.match(details, /chat-history-26\.0\.json/);
    assert.match(details, /server\.pem/);
    assert.match(details, /\.env /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('private terms fail in content, commit messages and file names; the list itself is local', () => {
  const { root, work } = makeRepo();
  try {
    const terms = join(root, 'terms.txt');
    writeFileSync(terms, '# comment\nSecretProject\nsome-plan.md\n');
    commit(work, 'docs/a.md', 'see the secretproject notes\n', 'notes');
    commit(work, 'docs/b.md', 'fine\n', 'mention SECRETPROJECT in a message');
    commit(work, 'docs/some-plan.md', 'fine\n', 'plan file');
    sh(work, ['push', 'origin', 'main']);
    const r = runChecks({ cwd: work, termsFile: terms });
    const details = r.failures.filter((f) => f.rule === 'terms').map((f) => f.detail).join('\n');
    assert.match(details, /private term in docs\/a\.md/);
    assert.match(details, /commit message of/);
    assert.match(details, /file name docs\/some-plan\.md/);
    assert.ok(!details.toLowerCase().includes('secretproject'), 'the term is not echoed');
    const none = check(work);
    assert.ok(none.warnings.some((w) => w.rule === 'terms' && /did not run/.test(w.detail)), 'a missing list is a warning, not silence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('home paths and personal emails warn but do not fail; placeholders and example domains are quiet', () => {
  const { root, work } = makeRepo();
  try {
    commit(work, 'a.js', 'const p = "/Users/realperson/Library/x";\nconst q = "/Users/you/x";\nconst m = "me@example.com";\nconst n = "x@" + "private-corp.io";\nconst w = "a@private-corp.io";\n', 'paths');
    sh(work, ['push', 'origin', 'main']);
    const r = check(work);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.warnings.map((w) => w.rule).filter((x) => x !== 'terms').sort(), ['email', 'home-path']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an allowlist entry with a reason silences exactly that rule and file; one without a reason is refused', () => {
  const { root, work } = makeRepo();
  try {
    commit(work, 'test/detector.test.mjs', 'const fixture = "-----BEGIN PRIVATE KEY-----";\n', 'fixture');
    commit(work, 'src/real.js', 'const fixture = "-----BEGIN PRIVATE KEY-----";\n', 'real');
    sh(work, ['push', 'origin', 'main']);
    const list = join(root, 'allow.json');
    writeFileSync(list, JSON.stringify([{ rule: 'secrets', file: 'test/detector.test.mjs', reason: 'detector fixture' }]));
    const r = check(work, { allowlistFile: list });
    assert.deepEqual(r.failures.map((f) => f.detail), ['private-key shape in src/real.js, commit ' + r.failures[0].detail.slice(-8)]);
    writeFileSync(list, JSON.stringify([{ rule: 'secrets', file: 'test/detector.test.mjs' }]));
    assert.throws(() => check(work, { allowlistFile: list }), /needs rule, file and reason/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--local reads local refs without touching the network', () => {
  const { root, work } = makeRepo();
  try {
    sh(work, ['branch', 'wip']);
    sh(work, ['remote', 'set-url', 'origin', join(root, 'does-not-exist.git')]);
    const r = runChecks({ cwd: work, local: true, termsFile: join(work, 'none.txt') });
    assert.ok(r.failures.some((f) => f.rule === 'refs' && /branch wip/.test(f.detail)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the command exits 0 on a clean repo, 1 on a failure and 2 on bad usage', () => {
  const { root, work } = makeRepo();
  try {
    const run = (...a) => spawnSync('node', [SCRIPT, '--repo', work, '--terms', join(root, 'none.txt'), ...a], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    sh(work, ['push', 'origin', 'main:refs/heads/extra']);
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /RESULT: do not make this repository public/);
    assert.equal(run('--bogus').status, 2);
    assert.equal(run('--allow').status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the public-guard workflow runs on the public event, is read-only, and only the revert step holds the admin secret', () => {
  const wf = readFileSync(fileURLToPath(new URL('../.github/workflows/public-guard.yml', import.meta.url)), 'utf8');
  const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /^on:\n  public: \{\}\n  workflow_dispatch: \{\}\n/m);
  assert.match(code, /^permissions:\n  contents: read\n/m);
  assert.ok(!/(contents|issues|pull-requests|administration): write/.test(code), 'no write permission');
  assert.ok(code.includes('run: node scripts/pre-public-check.mjs'));
  assert.ok(code.includes('fetch-depth: 0'), 'the whole history is checked out');
  const uses = [...code.matchAll(/secrets\.PUBLIC_GUARD_PAT/g)].length;
  assert.equal(uses, 1, 'the secret is named once, in the revert step only');
  const revert = code.split('- name: Flip back to private after a failed check')[1];
  assert.ok(revert.includes('GH_TOKEN: ${{ secrets.PUBLIC_GUARD_PAT }}'));
  assert.ok(revert.includes("failure() && github.event_name == 'public'"), 'the revert only fires on a real flip');
  assert.ok(revert.includes('[ -z "$GH_TOKEN" ]'), 'without the secret it fails loudly instead of doing nothing');
});
