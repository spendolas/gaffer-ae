import { execFile as _execFile } from 'node:child_process';
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
