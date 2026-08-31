import { execFile as _execFile, spawn as _spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const execFileP = promisify(_execFile);

export async function authStatus(claudeBin, opts = {}) {
  const execFileFn = opts.execFileFn || execFileP;
  let out;
  try {
    const r = await execFileFn(claudeBin, ['auth', 'status', '--json'],
      { env: opts.env || process.env, timeout: 15000, windowsHide: true });
    out = r && r.stdout;
  } catch (e) {
    // `claude auth status --json` exits non-zero when logged out but still
    // prints valid JSON on stdout — recover it from the error object rather
    // than treating logged-out as indeterminate (which would hide the card).
    out = e && e.stdout;
  }
  try {
    const j = JSON.parse(out);
    if (typeof j.loggedIn !== 'boolean') return { loggedIn: null };
    return {
      loggedIn: j.loggedIn, authMethod: j.authMethod, email: j.email,
      orgName: j.orgName, subscriptionType: j.subscriptionType,
    };
  } catch (e) {
    return { loggedIn: null };
  }
}

export function signIn(claudeBin, mode, opts = {}) {
  const pollMs = opts.pollMs || 2000;
  const timeoutMs = opts.timeoutMs || 300000;
  const spawnFn = opts.spawnFn || _spawn;
  const statusFn = opts.statusFn || (() => authStatus(claudeBin, { env: opts.env }));
  const flag = mode === 'console' ? '--console' : '--claudeai';

  let child, poll, deadline, settled = false;
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });
  function finish(result) {
    if (settled) return;
    settled = true;
    clearInterval(poll); clearTimeout(deadline);
    resolveDone(result);
  }

  child = spawnFn(claudeBin, ['auth', 'login', flag],
    { env: opts.env || process.env, windowsHide: true });
  if (child && child.on) {
    child.on('exit', () => { if (!settled) statusFn().then((s) => {
      if (s && s.loggedIn === true) finish({ ok: true, status: s });
      else finish({ ok: false, degraded: true });
    }).catch(() => {}); });
    child.on('error', () => finish({ ok: false, error: 'spawn failed' }));
  }
  try { if (opts.onStarted) opts.onStarted(); } catch (e) {}

  poll = setInterval(() => {
    statusFn().then((s) => { if (s && s.loggedIn === true) finish({ ok: true, status: s }); }).catch(() => {});
  }, pollMs);
  deadline = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);

  return { done, cancel: () => { try { child && child.kill && child.kill(); } catch (e) {} finish({ ok: false, error: 'cancelled' }); } };
}

export async function signOut(claudeBin, opts = {}) {
  const execFileFn = opts.execFileFn || execFileP;
  try {
    await execFileFn(claudeBin, ['auth', 'logout'],
      { env: opts.env || process.env, timeout: 15000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'logout failed' };
  }
}

// ── Fast, subprocess-free auth identity (for the on-connect account card) ──
//
// `claude auth status --json` is a ~500ms subprocess spawned on EVERY panel
// connect. The card only needs identity + signed-in state, both of which Claude
// Code already persists to disk, so we read them directly (single-digit ms) and
// keep the subprocess only for the sign-in/sign-out result paths.
//
// Where each field comes from (verified against a live signed-in account, whose
// `claude auth status --json` returned the identical values):
//   - loggedIn        = a valid OAuth access token exists (keychain / creds file)
//   - subscriptionType= that credential's `claudeAiOauth.subscriptionType` (plan)
//   - email / orgName = `~/.claude.json` oauthAccount.emailAddress /
//                       .organizationName (Claude Code's persisted profile)
//   - authMethod      = 'claude.ai' for OAuth, 'apiKey' for explicit-key installs
//
// Signed-out semantics avoid a FALSE "signed out": loggedIn is `false` ONLY when
// there is definitively no credential (keychain reports the item absent AND no
// creds file), else `null` (indeterminate — e.g. a transient keychain read
// error). The panel treats null as "keep waiting", not "signed out". No secret
// ever leaves memory or reaches a log.

// Parse Claude Code's OAuth credential blob. Returns { token, subscriptionType }
// or null. Mirrors chat-handler's parseOauthBlob but also surfaces the plan.
function parseOauthCredential(raw) {
  try {
    const o = JSON.parse(String(raw || '')).claudeAiOauth;
    return o && o.accessToken
      ? { token: String(o.accessToken), subscriptionType: o.subscriptionType }
      : null;
  } catch (e) { return null; }
}

// Claude Code's persisted profile lives at ~/.claude.json (CLAUDE_CONFIG_DIR
// overrides the dir). Returns the oauthAccount object or null.
function readOauthAccount(env) {
  const candidates = [];
  if (env.CLAUDE_CONFIG_DIR) candidates.push(join(env.CLAUDE_CONFIG_DIR, '.claude.json'));
  candidates.push(join(homedir(), '.claude.json'));
  for (let i = 0; i < candidates.length; i++) {
    try {
      const acc = JSON.parse(readFileSync(candidates[i], 'utf8')).oauthAccount;
      if (acc) return acc;
    } catch (e) { /* missing/corrupt — try the next candidate */ }
  }
  return null;
}

// The credential file route (all platforms; the primary route off macOS). A
// present-but-unparseable file is NOT a definitive absence.
function readCredentialFile(env) {
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  try {
    const parsed = parseOauthCredential(readFileSync(join(dir, '.credentials.json'), 'utf8'));
    return parsed ? { present: true, token: parsed.token, subscriptionType: parsed.subscriptionType }
      : { present: false, definitive: false };
  } catch (e) {
    // ENOENT => the file genuinely isn't there (a definitive absence for this
    // route); any other fs error is indeterminate.
    return { present: false, definitive: !!(e && e.code === 'ENOENT') };
  }
}

// macOS stores the credential in the login keychain under "Claude Code-
// credentials" (an item with an open ACL — reading it fires no user prompt).
// Resolves { present:true, token, subscriptionType } | { present:false,
// definitive } — definitive only when the keychain reports the item absent
// (errSecItemNotFound == exit 44).
function readMacKeychain(env, execFileFn) {
  return new Promise((resolve) => {
    const args = ['find-generic-password'];
    if (env.USER) args.push('-a', env.USER);
    args.push('-s', 'Claude Code-credentials', '-w');
    execFileFn('/usr/bin/security', args, { env, timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (!err) {
        const parsed = parseOauthCredential(stdout);
        return resolve(parsed
          ? { present: true, token: parsed.token, subscriptionType: parsed.subscriptionType }
          : { present: false, definitive: false });
      }
      const notFound = err.code === 44
        || /could not be found|not be found in the keychain/i.test(String(err.stderr || err.message || ''));
      resolve({ present: false, definitive: !!notFound });
    });
  });
}

// Resolve the OAuth credential from disk/keychain. macOS tries the keychain
// first, then the creds file; a definitive absence needs BOTH routes to agree
// the credential genuinely isn't there.
async function readOauthCredential(env, opts = {}) {
  const execFileFn = opts.execFileFn || _execFile;
  if (process.platform === 'darwin') {
    const kc = await readMacKeychain(env, execFileFn);
    if (kc.present) return kc;
    const file = readCredentialFile(env);
    if (file.present) return file;
    return { present: false, definitive: !!(kc.definitive && file.definitive) };
  }
  return readCredentialFile(env);
}

// Fast, subprocess-free replacement for authStatus() on the on-connect hot path.
// Never throws. Returns the same shape sendAuthStatus() consumes:
//   { loggedIn, authMethod, email, orgName, subscriptionType }
// Injection seams (tests): opts.readAccount, opts.readCredential.
export async function authIdentityFromDisk(env, opts = {}) {
  env = env || process.env;
  try {
    // Explicit-credential installs are signed in by definition; no OAuth
    // profile (email/org/plan) exists for them.
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
      return { loggedIn: true, authMethod: 'apiKey' };
    }
    const readAccount = opts.readAccount || readOauthAccount;
    const readCredential = opts.readCredential || readOauthCredential;
    const account = readAccount(env) || null;
    const cred = await readCredential(env, opts);
    if (cred && cred.present && cred.token) {
      return {
        loggedIn: true,
        authMethod: 'claude.ai',
        email: (account && account.emailAddress) || undefined,
        orgName: (account && account.organizationName) || undefined,
        subscriptionType: cred.subscriptionType,
      };
    }
    // No usable credential. Definitive absence => signed out; otherwise
    // indeterminate (never a false signed-out).
    if (cred && cred.definitive) return { loggedIn: false };
    return { loggedIn: null };
  } catch (e) {
    return { loggedIn: null };
  }
}
