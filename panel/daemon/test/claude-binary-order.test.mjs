import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  resolveOrder, resolveClaude, checkCandidate, healthCheckEnv, findClaudeBinary,
  resetClaudeLookupForTests, INSTALL_LINKS, formatNotFoundMessage,
} from '../claude-binary.js';

// The lookup order and the health check, driven by fake fs/exec so no real
// Claude binary is needed. The order itself was decided by the owner: pin,
// then the desktop app's copy, then a standalone CLI.

var APP = ['/app/2.1.289/h1/claude.app/Contents/MacOS/claude', '/app/2.1.288/h0/claude.app/Contents/MacOS/claude'];
var ENV = { HOME: '/Users/me', PATH: '/usr/bin', SHELL: '/bin/zsh' };

// files: { path: { file: true|false, version: 'x.y.z' | null, stdout?: raw
//          --version output, timeouts?: how many --version attempts time out } }
// pathHits / shellLine: what `which claude` and the login shell print.
function fakeDeps(files, extra) {
  extra = extra || {};
  var attempts = {};
  var d = {
    log: [], warned: [], spawned: [], execOpts: [],
    statSync: function (p) {
      if (!(p in files)) { var e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isFile: function () { return files[p].file !== false; } };
    },
    accessSync: function (p) {
      if (!(p in files) || files[p].exec === false) { var e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
    },
    execFile: function (p, args, opts, cb) {
      d.spawned.push(p); d.execOpts.push(opts);
      var f = files[p] || {};
      var v = f.version;
      attempts[p] = (attempts[p] || 0) + 1;
      var timesOut = f.timeouts && attempts[p] <= f.timeouts;
      setTimeout(function () {
        if (timesOut) { var te = new Error('killed'); te.killed = true; te.signal = 'SIGTERM'; te.code = null; return cb(te, '', ''); }
        if (v === null) return cb(new Error('spawn failed'));
        cb(null, f.stdout !== undefined ? f.stdout : v + ' (Claude Code)\n', '');
      }, 0);
    },
    execSync: function (cmd) {
      if (/^which|^where/.test(cmd)) {
        if (!extra.pathHits || !extra.pathHits.length) throw new Error('not found');
        return extra.pathHits.join('\n') + '\n';
      }
      if (/command -v claude/.test(cmd)) {
        if (!extra.shellLine) throw new Error('not found');
        return extra.shellLine + '\n';
      }
      throw new Error('unexpected command ' + cmd);
    },
    warn: function (l) { d.warned.push(l); },
  };
  d.log = d.warn;
  return d;
}

function opts(config, deps) {
  return { platform: 'darwin', env: ENV, config: config || {}, desktopCandidates: APP, deps: deps };
}

test('resolveOrder: pin first, then desktop app (newest first), then known locations, PATH, login shell', () => {
  var order = resolveOrder({ platform: 'darwin', env: ENV, config: { claudeBin: '/pinned/claude' }, desktopCandidates: APP });
  var steps = order.map(function (e) { return e.step; });
  assert.equal(order[0].step, 'config'); assert.equal(order[0].path, '/pinned/claude'); assert.ok(order[0].pinned);
  assert.deepEqual(order.slice(1, 3).map(function (e) { return e.path; }), APP, 'desktop app copies right after the pin, newest first');
  assert.ok(steps.indexOf('known location') > steps.lastIndexOf('desktop app'));
  assert.ok(steps.indexOf('PATH') > steps.lastIndexOf('known location'));
  assert.equal(steps[steps.length - 1], 'login shell');
  assert.ok(order.indexOf(order.filter(function (e) { return e.path === '/usr/local/bin/claude'; })[0]) > 0, 'standalone Homebrew path listed');
});

test('resolveOrder: win32 has no login-shell step and uses the Windows candidate sets', () => {
  var order = resolveOrder({ platform: 'win32', env: { APPDATA: '/nope', USERPROFILE: 'C:\\U', LOCALAPPDATA: 'C:\\L' }, config: {} });
  assert.equal(order.filter(function (e) { return e.step === 'login shell'; }).length, 0);
  assert.ok(order.some(function (e) { return /\.local[\\/]bin[\\/]claude\.exe$/.test(e.path || ''); }));
});

test('resolveOrder: linux has no desktop-app step', () => {
  var order = resolveOrder({ platform: 'linux', env: ENV, config: {} });
  assert.equal(order.filter(function (e) { return e.step === 'desktop app'; }).length, 0);
  assert.ok(order.some(function (e) { return e.step === 'known location'; }));
});

test('resolveOrder: pin "app" marks only desktop-app entries, "cli" only standalone ones', () => {
  var app = resolveOrder({ platform: 'darwin', env: ENV, config: { claudeBin: 'app' }, desktopCandidates: APP });
  assert.deepEqual(app.filter(function (e) { return e.pinned; }).map(function (e) { return e.step; }), ['desktop app', 'desktop app']);
  var cli = resolveOrder({ platform: 'darwin', env: ENV, config: { claudeBin: 'cli' }, desktopCandidates: APP });
  var pinnedSteps = cli.filter(function (e) { return e.pinned; }).map(function (e) { return e.step; });
  assert.ok(pinnedSteps.indexOf('desktop app') === -1 && pinnedSteps.indexOf('known location') >= 0 && pinnedSteps.indexOf('PATH') >= 0 && pinnedSteps.indexOf('login shell') >= 0);
  assert.equal(cli.filter(function (e) { return e.step === 'config'; }).length, 0, 'a mode word is never treated as a path');
});

test('unpinned: desktop app beats a working standalone CLI, and only the winner is spawned', async () => {
  var files = {}; files[APP[0]] = { version: '2.1.289' }; files['/usr/local/bin/claude'] = { version: '2.1.236' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({}, deps));
  assert.equal(hit.path, APP[0]); assert.equal(hit.step, 'desktop app'); assert.match(hit.version, /^2\.1\.289/);
  assert.deepEqual(deps.spawned, [APP[0]], 'the CLI is never spawned once the app copy works');
  assert.equal(deps.execOpts[0].timeout, 5000); assert.equal(deps.execOpts[0].windowsHide, true);
});

test('an explicit path pin beats everything', async () => {
  var files = { '/pinned/claude': { version: '2.0.1' } }; files[APP[0]] = { version: '2.1.289' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({ claudeBin: '/pinned/claude' }, deps));
  assert.equal(hit.path, '/pinned/claude'); assert.equal(hit.step, 'config');
  assert.deepEqual(deps.spawned, ['/pinned/claude']);
});

test('pin "cli" skips the desktop app even when it works', async () => {
  var files = {}; files[APP[0]] = { version: '2.1.289' }; files['/usr/local/bin/claude'] = { version: '2.1.236' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({ claudeBin: 'cli' }, deps));
  assert.equal(hit.path, '/usr/local/bin/claude'); assert.equal(hit.step, 'known location');
  assert.equal(deps.spawned.indexOf(APP[0]), -1);
});

test('pin "app" uses only the desktop app when it works', async () => {
  var files = {}; files[APP[1]] = { version: '2.1.288' }; files['/usr/local/bin/claude'] = { version: '2.1.236' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({ claudeBin: 'app' }, deps));
  assert.equal(hit.path, APP[1]);
  assert.equal(deps.warned.filter(function (l) { return /pinned claudeBin/.test(l); }).length, 0, 'satisfied pin is not reported as a fallback');
});

test('an unusable pin is logged and the lookup continues automatically (never silent, never fatal)', async () => {
  var files = {}; files['/usr/local/bin/claude'] = { version: '2.1.236' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({ claudeBin: '/gone/claude' }, deps));
  assert.equal(hit.path, '/usr/local/bin/claude');
  assert.ok(deps.warned.some(function (l) { return l === 'Gaffer: pinned claudeBin "/gone/claude" not usable, falling back to automatic lookup'; }), JSON.stringify(deps.warned));

  var deps2 = fakeDeps(files);
  var hit2 = await resolveClaude(opts({ claudeBin: 'app' }, deps2));
  assert.equal(hit2.path, '/usr/local/bin/claude', 'pin "app" with no app copy falls back to the CLI');
  assert.ok(deps2.warned.some(function (l) { return /pinned claudeBin "app" not usable/.test(l); }));
});

test('a directory (claude.app itself) is skipped even though it is "executable"', async () => {
  var files = {}; files[APP[0]] = { file: false, version: '2.1.289' }; files['/usr/local/bin/claude'] = { version: '2.1.236' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({}, deps));
  assert.equal(hit.path, '/usr/local/bin/claude');
  assert.equal(deps.spawned.indexOf(APP[0]), -1, 'a directory is never spawned');
  assert.ok(deps.warned.some(function (l) { return l.indexOf(APP[0]) >= 0 && /not a regular file/.test(l); }), 'the skip names the path and reason');
});

test('a candidate whose --version fails or prints no version is skipped, next one wins', async () => {
  var files = {}; files[APP[0]] = { version: null }; files[APP[1]] = { version: 'garbage' }; files['/usr/local/bin/claude'] = { version: '2.1.236' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({}, deps));
  assert.equal(hit.path, '/usr/local/bin/claude');
  assert.deepEqual(deps.spawned, [APP[0], APP[1], '/usr/local/bin/claude'], 'tried in order, stopped at the winner');
  assert.ok(deps.warned.some(function (l) { return l.indexOf(APP[0]) >= 0 && /--version failed/.test(l); }));
  assert.ok(deps.warned.some(function (l) { return l.indexOf(APP[1]) >= 0 && /no version number/.test(l); }));
});

test('PATH hits are health-checked too, and the lookup runs with a timeout', async () => {
  var files = { '/opt/other/bin/claude': { version: '2.1.240' } };
  var deps = fakeDeps(files, { pathHits: ['/opt/other/bin/claude'] });
  var seenTimeout;
  var realExecSync = deps.execSync;
  deps.execSync = function (cmd, o) { if (/^which/.test(cmd)) seenTimeout = o.timeout; return realExecSync(cmd, o); };
  var diag = {};
  var hit = await resolveClaude(Object.assign(opts({}, deps), { diag: diag }));
  assert.equal(hit.path, '/opt/other/bin/claude'); assert.equal(hit.step, 'PATH');
  assert.equal(seenTimeout, 5000);
  assert.deepEqual(diag.pathLines, ['/opt/other/bin/claude'], 'diag records what PATH returned');
});

test('login shell: alias text is never treated as a path; an absolute path is', async () => {
  var deps = fakeDeps({}, { shellLine: "alias claude='/Users/me/.claude/local/claude --flag'" });
  var hit = await resolveClaude(opts({}, deps));
  assert.equal(hit, null, 'alias text produces no binary');
  assert.ok(deps.spawned.every(function (p) { return !/^alias/.test(p); }));

  var files = { '/Users/me/.volta/bin/claude': { version: '2.1.250' } };
  var deps2 = fakeDeps(files, { shellLine: '/Users/me/.volta/bin/claude' });
  var hit2 = await resolveClaude(opts({}, deps2));
  assert.equal(hit2.path, '/Users/me/.volta/bin/claude'); assert.equal(hit2.step, 'login shell');
});

test('nothing works anywhere: resolveClaude returns null', async () => {
  var deps = fakeDeps({});
  assert.equal(await resolveClaude(opts({}, deps)), null);
});

test('checkCandidate: missing file is "missing", regular file + version passes', async () => {
  var files = { '/x/claude': { version: '2.1.289' } };
  var deps = fakeDeps(files);
  var ok = await checkCandidate('/x/claude', deps);
  assert.equal(ok.ok, true); assert.equal(ok.version, '2.1.289 (Claude Code)');
  var missing = await checkCandidate('/x/nope', deps);
  assert.deepEqual(missing, { ok: false, reason: 'missing' });
});

// Health check environment: the same shape as the chat spawn's PATH, with the
// candidate's own folder first, so a binary that needs its siblings (or node)
// on PATH is not rejected by a check that the real chat would pass.
test('health check runs with the candidate folder first on PATH, then the chat-spawn extras, then the inherited PATH', async () => {
  var files = {}; files[APP[0]] = { version: '2.1.289' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({}, deps));
  assert.equal(hit.path, APP[0]);
  var env = deps.execOpts[0].env;
  assert.ok(env, 'an env is passed to execFile');
  var parts = env.PATH.split(':');
  assert.equal(parts[0], dirname(APP[0]), 'candidate folder first');
  assert.deepEqual(parts.slice(1, 4), ['/opt/homebrew/bin', '/usr/local/bin', '/Users/me/.local/bin']);
  assert.equal(parts[parts.length - 1], '/usr/bin', 'inherited PATH last');
  assert.equal(env.HOME, '/Users/me', 'other env vars carried over');
});

test('healthCheckEnv on win32 uses ; and adds only the candidate folder before the inherited PATH', () => {
  var env = healthCheckEnv('C:\\Users\\x\\.local\\bin\\claude.exe', 'win32', { PATH: 'C:\\Windows' });
  assert.equal(env.PATH, 'C:\\Users\\x\\.local\\bin;C:\\Windows');
  var noPath = healthCheckEnv('/x/claude', 'linux', { HOME: '/home/u' });
  assert.equal(noPath.PATH, '/x:/opt/homebrew/bin:/usr/local/bin:/home/u/.local/bin');
});

test('a warning line printed before the version does not reject a working binary', async () => {
  var files = { '/x/claude': { version: '2.1.289', stdout: '(node:4242) Warning: something deprecated\n2.1.289 (Claude Code)\n' } };
  var r = await checkCandidate('/x/claude', fakeDeps(files));
  assert.equal(r.ok, true);
  assert.equal(r.version, '2.1.289 (Claude Code)', 'the version line, not the warning');
  var none = await checkCandidate('/x/claude', fakeDeps({ '/x/claude': { version: 'x', stdout: 'Warning only\nno version here\n' } }));
  assert.equal(none.ok, false); assert.match(none.reason, /no version number/);
});

// Health-check timeouts: a slow-starting real binary is retried once with a
// longer budget, then accepted unseen rather than silently skipped. Other
// failures still skip.
test('a --version timeout is retried once with 20 s, and the retry result is used', async () => {
  var files = { '/x/claude': { version: '2.1.289', timeouts: 1 } };
  var deps = fakeDeps(files);
  var r = await checkCandidate('/x/claude', deps);
  assert.equal(r.ok, true); assert.equal(r.version, '2.1.289 (Claude Code)');
  assert.deepEqual(deps.execOpts.map(function (o) { return o.timeout; }), [5000, 20000]);
  assert.ok(deps.warned.some(function (l) { return /timed out after 5000 ms, retrying once with 20000 ms: \/x\/claude/.test(l); }));
});

test('two --version timeouts accept the candidate with version unknown and log it', async () => {
  var files = { '/x/claude': { version: '2.1.289', timeouts: 2 } };
  var deps = fakeDeps(files);
  var r = await checkCandidate('/x/claude', deps);
  assert.equal(r.ok, true); assert.equal(r.version, 'unknown'); assert.equal(r.timedOut, true);
  assert.equal(deps.spawned.length, 2, 'exactly two attempts, never a third');
  assert.ok(deps.warned.some(function (l) { return /timed out twice, accepting the binary with version unknown: \/x\/claude/.test(l); }));
});

test('a timing-out desktop app copy wins the lookup instead of falling through to the CLI', async () => {
  var files = {}; files[APP[0]] = { version: '2.1.289', timeouts: 2 }; files['/usr/local/bin/claude'] = { version: '2.1.236' };
  var deps = fakeDeps(files);
  var hit = await resolveClaude(opts({}, deps));
  assert.equal(hit.path, APP[0]); assert.equal(hit.version, 'unknown');
  assert.equal(deps.spawned.indexOf('/usr/local/bin/claude'), -1);
});

test('a non-timeout --version failure is not retried and still skips the candidate', async () => {
  var files = { '/x/claude': { version: null } };
  var deps = fakeDeps(files);
  var r = await checkCandidate('/x/claude', deps);
  assert.equal(r.ok, false);
  assert.equal(deps.spawned.length, 1, 'no retry for a plain failure');
});

// findClaudeBinary: concurrent callers share one lookup; the cache is
// re-checked without a spawn, except that a newer desktop app version folder
// drops it.
function findOpts(deps, extra) {
  return Object.assign({ platform: 'darwin', env: ENV, config: {}, desktopCandidates: APP, deps: deps }, extra || {});
}

test('two concurrent findClaudeBinary calls run the health check once and get the same path', async () => {
  resetClaudeLookupForTests();
  var files = {}; files[APP[0]] = { version: '2.1.289' };
  var deps = fakeDeps(files);
  var both = await Promise.all([findClaudeBinary(findOpts(deps)), findClaudeBinary(findOpts(deps))]);
  assert.deepEqual(both, [APP[0], APP[0]]);
  assert.deepEqual(deps.spawned, [APP[0]], 'one --version for two callers');
  // A third call afterwards is served from the cache, still without a spawn.
  assert.equal(await findClaudeBinary(findOpts(deps)), APP[0]);
  assert.equal(deps.spawned.length, 1);
  resetClaudeLookupForTests();
});

test('a failed lookup clears the in-flight slot so the next call tries again', async () => {
  resetClaudeLookupForTests();
  var deps = fakeDeps({});
  var results = await Promise.allSettled([findClaudeBinary(findOpts(deps)), findClaudeBinary(findOpts(deps))]);
  assert.ok(results.every(function (r) { return r.status === 'rejected' && /Claude CLI not found/.test(r.reason.message); }));
  var files = { '/usr/local/bin/claude': { version: '2.1.236' } };
  var deps2 = fakeDeps(files);
  assert.equal(await findClaudeBinary(findOpts(deps2)), '/usr/local/bin/claude', 'retried, not stuck on the failed promise');
  resetClaudeLookupForTests();
});

test('a cached desktop-app hit is dropped when a newer version folder appears (readdir only, no spawn until then)', async () => {
  resetClaudeLookupForTests();
  var home = mkdtempSync(join(tmpdir(), 'gaffer-home-'));
  var base = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  var LEAF = ['claude.app', 'Contents', 'MacOS', 'claude'];
  var old = join.apply(null, [base, '2.1.288', 'h0'].concat(LEAF));
  var newer = join.apply(null, [base, '2.1.289', 'h1'].concat(LEAF));
  try {
    mkdirSync(join(base, '2.1.288', 'h0'), { recursive: true });
    var files = {}; files[old] = { version: '2.1.288' }; files[newer] = { version: '2.1.289' };
    var deps = fakeDeps(files);
    var env = { HOME: home, PATH: '/usr/bin', SHELL: '/bin/zsh' };
    // desktopCandidates NOT injected: the real scan of <home> runs.
    var o = { platform: 'darwin', env: env, config: {}, deps: deps };
    assert.equal(await findClaudeBinary(o), old);
    assert.equal(await findClaudeBinary(o), old, 'cache hit');
    assert.deepEqual(deps.spawned, [old], 'cache check spawns nothing');

    mkdirSync(join(base, '2.1.289', 'h1'), { recursive: true });
    assert.equal(await findClaudeBinary(o), newer, 're-resolved onto the newer version');
    assert.deepEqual(deps.spawned, [old, newer]);
    assert.ok(deps.warned.some(function (l) { return /newer Claude desktop app version folder appeared \(2\.1\.289 > 2\.1\.288\)/.test(l); }));
    assert.equal(await findClaudeBinary(o), newer, 'and cached again');
    assert.equal(deps.spawned.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
    resetClaudeLookupForTests();
  }
});

test('a cached standalone CLI hit is not disturbed by desktop app folders', async () => {
  resetClaudeLookupForTests();
  var files = { '/usr/local/bin/claude': { version: '2.1.236' } };
  var deps = fakeDeps(files);
  assert.equal(await findClaudeBinary(findOpts(deps, { desktopCandidates: [] })), '/usr/local/bin/claude');
  assert.equal(await findClaudeBinary(findOpts(deps, { desktopCandidates: [] })), '/usr/local/bin/claude');
  assert.equal(deps.spawned.length, 1);
  resetClaudeLookupForTests();
});

test('install links and the not-found message tail', () => {
  assert.equal(INSTALL_LINKS.desktop, 'https://claude.com/download');
  assert.equal(INSTALL_LINKS.cli, 'https://claude.ai/code');
  var msg = formatNotFoundMessage({}, '/cfg/config.json');
  assert.ok(msg.indexOf(INSTALL_LINKS.desktop) >= 0, 'desktop app link');
  assert.ok(msg.indexOf(INSTALL_LINKS.cli) >= 0, 'CLI link');
  assert.match(msg, /"claudeBin": "app"/); assert.match(msg, /"claudeBin": "cli"/);
  assert.match(msg, /\/cfg\/config\.json/);
  assert.doesNotMatch(msg, /[\u2013\u2014]/, 'no em or en dashes');
});
