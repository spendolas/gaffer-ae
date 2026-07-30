import { execFile as _execFile, spawn as _spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(_execFile);

export async function authStatus(claudeBin, opts = {}) {
  const execFileFn = opts.execFileFn || execFileP;
  try {
    const { stdout } = await execFileFn(claudeBin, ['auth', 'status', '--json'],
      { env: opts.env || process.env, timeout: 15000, windowsHide: true });
    const j = JSON.parse(stdout);
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
