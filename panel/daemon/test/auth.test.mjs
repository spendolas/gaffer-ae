import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authStatus, authIdentityFromDisk, signIn, signOut } from '../auth.js';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(_execFile);

const okJson = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.co', orgName: 'Acme', subscriptionType: 'team' });

function fakeBin(state) {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-auth-'));
  const sf = join(dir, 'state.json');
  writeFileSync(sf, JSON.stringify(state));
  const stub = fileURLToPath(new URL('../test-fixtures/fake-claude.mjs', import.meta.url));
  // execFileFn that shells the stub with the statefile prepended
  const execFileFn = (bin, args, o) => execFileP(process.execPath, [stub, sf, ...args], o);
  return { execFileFn, argvFile: sf + '.argv' };
}

test('authStatus parses logged-in JSON', async () => {
  const execFileFn = async () => ({ stdout: okJson });
  const s = await authStatus('claude', { execFileFn });
  assert.equal(s.loggedIn, true);
  assert.equal(s.email, 'a@b.co');
  assert.equal(s.subscriptionType, 'team');
});

test('authStatus returns loggedIn:null on non-JSON', async () => {
  const execFileFn = async () => ({ stdout: 'not json' });
  const s = await authStatus('claude', { execFileFn });
  assert.equal(s.loggedIn, null);
});

test('authStatus returns loggedIn:null when the CLI errors', async () => {
  const execFileFn = async () => { throw new Error('spawn failed'); };
  const s = await authStatus('claude', { execFileFn });
  assert.equal(s.loggedIn, null);
});

// Regression: `claude auth status --json` exits non-zero when logged OUT
// (execFile rejects) but still prints valid JSON. Must parse it as
// loggedIn:false, not swallow it to null — else the sign-in card never shows.
test('authStatus parses logged-out JSON even when the CLI exits non-zero', async () => {
  const execFileFn = async () => {
    const e = new Error('Command failed: exit 1');
    e.code = 1;
    e.stdout = JSON.stringify({ loggedIn: false, authMethod: 'none' });
    throw e;
  };
  const s = await authStatus('claude', { execFileFn });
  assert.equal(s.loggedIn, false);
});

function fakeChild() {
  let exitCb;
  return { on: (e, cb) => { if (e === 'exit') exitCb = cb; }, kill: () => exitCb && exitCb(0), _exit: (c) => exitCb && exitCb(c) };
}

test('signIn resolves ok when a poll sees loggedIn:true', async () => {
  let calls = 0;
  const statusFn = async () => ({ loggedIn: ++calls >= 2 });   // false, then true
  const spawnFn = () => fakeChild();
  const { done } = signIn('claude', 'claudeai', { pollMs: 5, timeoutMs: 1000, spawnFn, statusFn });
  const r = await done;
  assert.equal(r.ok, true);
});

test('signIn passes the right login flag per mode', async () => {
  let argv;
  const spawnFn = (bin, args) => { argv = args; return fakeChild(); };
  const statusFn = async () => ({ loggedIn: true });
  await signIn('claude', 'console', { pollMs: 5, timeoutMs: 1000, spawnFn, statusFn }).done;
  assert.deepEqual(argv, ['auth', 'login', '--console']);
});

test('signIn degrades when the login child exits before login completes', async () => {
  const child = fakeChild();
  const spawnFn = () => child;
  const statusFn = async () => ({ loggedIn: false });
  const ctl = signIn('claude', 'claudeai', { pollMs: 5, timeoutMs: 1000, spawnFn, statusFn });
  child._exit(1);
  const r = await ctl.done;
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
});

test('signIn cancel stops polling and kills the child', async () => {
  let killed = false;
  const child = { on: () => {}, kill: () => { killed = true; } };
  const spawnFn = () => child;
  const statusFn = async () => ({ loggedIn: false });
  const ctl = signIn('claude', 'claudeai', { pollMs: 5, timeoutMs: 1000, spawnFn, statusFn });
  ctl.cancel();
  const r = await ctl.done;
  assert.equal(r.ok, false);
  assert.equal(killed, true);
});

test('signIn times out if status never returns loggedIn:true', async () => {
  const statusFn = async () => ({ loggedIn: false });
  const spawnFn = () => ({ on: () => {}, kill: () => {} });
  const { done } = signIn('claude', 'claudeai', { pollMs: 5, timeoutMs: 20, spawnFn, statusFn });
  const r = await done;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
});

test('signIn swallows statusFn rejection and continues polling', async () => {
  let calls = 0;
  const statusFn = async () => {
    ++calls;
    if (calls <= 2) throw new Error('boom');
    return { loggedIn: true };
  };
  const spawnFn = () => ({ on: () => {}, kill: () => {} });
  const { done } = signIn('claude', 'claudeai', { pollMs: 5, timeoutMs: 1000, spawnFn, statusFn });
  const r = await done;
  assert.equal(r.ok, true);
});

test('signIn returns control even if onStarted throws', async () => {
  const spawnFn = () => ({ on: () => {}, kill: () => {} });
  const statusFn = async () => ({ loggedIn: false });
  const onStarted = () => { throw new Error('boom'); };
  const ctl = signIn('claude', 'claudeai', { pollMs: 5, timeoutMs: 20, spawnFn, statusFn, onStarted });
  assert.equal(typeof ctl.cancel, 'function');
  ctl.cancel();
  const r = await ctl.done;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cancelled');
});

test('authStatus talks to the real CLI arg shape (auth status --json)', async () => {
  const { execFileFn, argvFile } = fakeBin({ loggedIn: true, email: 'x@y.z' });
  const s = await authStatus('claude', { execFileFn });
  assert.equal(s.loggedIn, true);
  assert.match(readFileSync(argvFile, 'utf8'), /"auth","status","--json"/);
});

test('authStatus reads logged-out state from the real (non-zero-exit) CLI shape', async () => {
  const { execFileFn } = fakeBin({ loggedIn: false, authMethod: 'none' });
  const s = await authStatus('claude', { execFileFn });
  assert.equal(s.loggedIn, false);
});

test('signOut runs auth logout and reports ok', async () => {
  const execFileFn = async () => ({ stdout: '' });
  const r = await signOut('claude', { execFileFn });
  assert.equal(r.ok, true);
});

test('signOut handles execFileFn rejection and reports error', async () => {
  const execFileFn = async () => { throw new Error('boom'); };
  const r = await signOut('claude', { execFileFn });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
});

test('signOut invokes the real CLI arg shape (auth logout)', async () => {
  const { execFileFn, argvFile } = fakeBin({});
  const r = await signOut('claude', { execFileFn });
  assert.equal(r.ok, true);
  assert.match(readFileSync(argvFile, 'utf8'), /"auth","logout"/);
});

// ── authIdentityFromDisk — the fast, subprocess-free account-card reader ──

test('authIdentityFromDisk maps a signed-in OAuth account from disk', async () => {
  const s = await authIdentityFromDisk({}, {
    readAccount: () => ({ emailAddress: 'a@b.co', organizationName: 'Acme' }),
    readCredential: async () => ({ present: true, token: 'tok', subscriptionType: 'team' }),
  });
  assert.equal(s.loggedIn, true);
  assert.equal(s.authMethod, 'claude.ai');
  assert.equal(s.email, 'a@b.co');
  assert.equal(s.orgName, 'Acme');
  assert.equal(s.subscriptionType, 'team');
});

test('authIdentityFromDisk returns loggedIn:false only on a definitive absence', async () => {
  const s = await authIdentityFromDisk({}, {
    readAccount: () => null,
    readCredential: async () => ({ present: false, definitive: true }),
  });
  assert.equal(s.loggedIn, false);
});

test('authIdentityFromDisk returns loggedIn:null on an indeterminate credential read', async () => {
  // A transient keychain/read error must NOT read as a false signed-out.
  const s = await authIdentityFromDisk({}, {
    readAccount: () => ({ emailAddress: 'a@b.co' }),
    readCredential: async () => ({ present: false, definitive: false }),
  });
  assert.equal(s.loggedIn, null);
});

test('authIdentityFromDisk treats an explicit API key as signed in without profile', async () => {
  let read = false;
  const s = await authIdentityFromDisk({ ANTHROPIC_API_KEY: 'sk-x' }, {
    readAccount: () => { read = true; return null; },
    readCredential: async () => { read = true; return null; },
  });
  assert.equal(s.loggedIn, true);
  assert.equal(s.authMethod, 'apiKey');
  assert.equal(read, false); // never touches disk when an explicit key is set
});

test('authIdentityFromDisk signs in even when the profile file is missing', async () => {
  // Credential present but ~/.claude.json unreadable: still signed in, email/org
  // simply omitted (card degrades gracefully).
  const s = await authIdentityFromDisk({}, {
    readAccount: () => null,
    readCredential: async () => ({ present: true, token: 'tok', subscriptionType: 'pro' }),
  });
  assert.equal(s.loggedIn, true);
  assert.equal(s.email, undefined);
  assert.equal(s.orgName, undefined);
  assert.equal(s.subscriptionType, 'pro');
});

test('authIdentityFromDisk never throws — a throwing reader yields loggedIn:null', async () => {
  const s = await authIdentityFromDisk({}, {
    readAccount: () => { throw new Error('boom'); },
    readCredential: async () => ({ present: true, token: 't' }),
  });
  assert.equal(s.loggedIn, null);
});
