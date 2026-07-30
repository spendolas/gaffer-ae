import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authStatus, signIn } from '../auth.js';

const okJson = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.co', orgName: 'Acme', subscriptionType: 'team' });

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
