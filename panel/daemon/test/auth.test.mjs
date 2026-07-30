import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authStatus } from '../auth.js';

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
