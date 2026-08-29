# Account Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user sign in to their Claude account from the Gaffer panel (subscription or Console), driven by `claude auth login` with `claude auth status --json` polling — no token handling by Gaffer.

**Architecture:** A new daemon `auth.js` module wraps `claude auth {status,login,logout}` with dependency-injection seams for deterministic tests. `panel-bridge.js`/`index.js` route four new WS messages to it. The panel shows a signed-out sign-in card and gates chat on auth state, with a `window.__gafferAuth` dev hook so the UI state machine is verifiable via CDP without a real signed-out backend.

**Tech Stack:** Node 20 ESM daemon, `node:test` + `node:assert` (built-in, no new deps), CEP panel (browser JS), CDP on the panel's remote-debugging port for UI verification.

## Global Constraints

- **DO NOT push/deploy until tests pass + one manual OAuth happy-path is confirmed.** Local commits only until then. (Spec deploy gate.)
- No new npm dependencies in the daemon (`node:test` is built-in). Daemon is ESM (`"type": "module"`).
- Gaffer never stores, injects, or logs a credential/token — it only invokes `claude auth {status,login,logout}`.
- `claude auth status --json` shape (verified, v2.1.212): `{ loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType }`.
- Login flags: `--claudeai` (mode `claudeai`), `--console` (mode `console`).
- Indeterminate auth (`loggedIn:null`) must never lock a user out of chat.
- Panel messages route via `panel-bridge.js` `this.onX(msg, socket)` callbacks, assigned in `index.js` — follow the existing `onAuthMcp` pattern exactly.
- `.ps1` files stay ASCII+BOM; all child spawns pass `windowsHide: true`.

## File Structure

- **Create** `panel/daemon/auth.js` — `authStatus()`, `signIn()`, `signOut()` with DI seams. One responsibility: CLI account auth.
- **Create** `panel/daemon/test/auth.test.mjs` — unit + integration tests (`node:test`).
- **Create** `panel/daemon/test/fake-claude.mjs` — stub `claude` binary for integration tests; records argv, responds to `auth` subcommands from a JSON state file.
- **Modify** `panel/daemon/panel-bridge.js` — dispatch `auth_status`/`sign_in`/`sign_out`/`cancel_sign_in`.
- **Modify** `panel/daemon/index.js` — assign `bridge.onAuthStatus`/`onSignIn`/`onSignOut`/`onCancelSignIn`; call `auth.js`; send responses.
- **Modify** `panel/index.html` — sign-in card (chat area) + account chip (drawer) markup & CSS.
- **Modify** `panel/main.js` — auth state, request-on-connect, message handlers, chat gating, button wiring, `window.__gafferAuth` dev hook.
- **Create** `scripts/test-panel-auth.mjs` — CDP-driven panel state-machine verification.

---

### Task 1: `auth.js` — `authStatus()`

**Files:**
- Create: `panel/daemon/auth.js`
- Test: `panel/daemon/test/auth.test.mjs`

**Interfaces:**
- Produces: `authStatus(claudeBin: string, opts?: { env?, execFileFn? }) => Promise<{ loggedIn: boolean|null, authMethod?, email?, orgName?, subscriptionType? }>`. `execFileFn(bin, args, opts) => Promise<{stdout}>` (defaults to promisified `node:child_process` execFile). Returns `{loggedIn:null}` on spawn error, non-zero exit, or non-JSON stdout.

- [ ] **Step 1: Write the failing test**

```js
// panel/daemon/test/auth.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test panel/daemon/test/auth.test.mjs`
Expected: FAIL — `Cannot find module '../auth.js'` (or `authStatus is not a function`).

- [ ] **Step 3: Write minimal implementation**

```js
// panel/daemon/auth.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test panel/daemon/test/auth.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add panel/daemon/auth.js panel/daemon/test/auth.test.mjs
git commit -m "feat(auth): authStatus() wraps claude auth status --json"
```

---

### Task 2: `auth.js` — `signIn()` poll/cancel/timeout

**Files:**
- Modify: `panel/daemon/auth.js`
- Test: `panel/daemon/test/auth.test.mjs`

**Interfaces:**
- Consumes: `authStatus` (Task 1).
- Produces: `signIn(claudeBin, mode: 'claudeai'|'console', opts?: { env?, pollMs?, timeoutMs?, onStarted?, spawnFn?, statusFn? }) => { done: Promise<{ ok: boolean, status?, error?, degraded?: boolean }>, cancel: () => void }`. `spawnFn(bin, args, opts) => ChildProcess-like { on(event, cb), kill() }`. `statusFn() => Promise<status>` (defaults to `() => authStatus(claudeBin, {env})`). Resolves `ok:true` when a poll sees `loggedIn:true`; `ok:false, degraded:true` if the login child exits before that; `ok:false, error:'timeout'` at `timeoutMs`.

- [ ] **Step 1: Write the failing test**

```js
// add to panel/daemon/test/auth.test.mjs
import { signIn } from '../auth.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test panel/daemon/test/auth.test.mjs`
Expected: FAIL — `signIn is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to panel/daemon/auth.js
import { spawn as _spawn } from 'node:child_process';

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
    }); });
    child.on('error', () => finish({ ok: false, error: 'spawn failed' }));
  }
  if (opts.onStarted) opts.onStarted();

  poll = setInterval(() => {
    statusFn().then((s) => { if (s && s.loggedIn === true) finish({ ok: true, status: s }); });
  }, pollMs);
  deadline = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);

  return { done, cancel: () => { try { child && child.kill && child.kill(); } catch (e) {} finish({ ok: false, error: 'cancelled' }); } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test panel/daemon/test/auth.test.mjs`
Expected: PASS (7/7 total).

- [ ] **Step 5: Commit**

```bash
git add panel/daemon/auth.js panel/daemon/test/auth.test.mjs
git commit -m "feat(auth): signIn() drives auth login + polls status"
```

---

### Task 3: `auth.js` — `signOut()` + real-CLI-args integration test

**Files:**
- Modify: `panel/daemon/auth.js`
- Create: `panel/daemon/test/fake-claude.mjs`
- Test: `panel/daemon/test/auth.test.mjs`

**Interfaces:**
- Produces: `signOut(claudeBin, opts?: { env?, execFileFn? }) => Promise<{ ok: boolean, error? }>`.
- The fake binary records argv and responds to `auth status --json` from a state file, so the integration test verifies the real command strings without touching a real account.

- [ ] **Step 1: Write the fake-claude stub + failing test**

```js
// panel/daemon/test/fake-claude.mjs  (invoked as: node fake-claude.mjs <statefile> auth ...)
import { readFileSync, appendFileSync } from 'node:fs';
const [ , , stateFile, ...argv ] = process.argv;
appendFileSync(stateFile + '.argv', JSON.stringify(argv) + '\n');
if (argv[0] === 'auth' && argv[1] === 'status') {
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  process.stdout.write(JSON.stringify(st)); process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'logout') { process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'login') { process.exit(0); }
process.exit(1);
```

```js
// add to panel/daemon/test/auth.test.mjs
import { signOut } from '../auth.js';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeBin(state) {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-auth-'));
  const sf = join(dir, 'state.json');
  writeFileSync(sf, JSON.stringify(state));
  const stub = new URL('./fake-claude.mjs', import.meta.url).pathname;
  // execFileFn that shells the stub with the statefile prepended
  const execFileFn = (bin, args, o) => import('node:util').then(u =>
    u.promisify((await import('node:child_process')).execFile)(process.execPath, [stub, sf, ...args], o));
  return { execFileFn, argvFile: sf + '.argv' };
}

test('authStatus talks to the real CLI arg shape (auth status --json)', async () => {
  const { execFileFn, argvFile } = fakeBin({ loggedIn: true, email: 'x@y.z' });
  const s = await authStatus('claude', { execFileFn });
  assert.equal(s.loggedIn, true);
  assert.match(readFileSync(argvFile, 'utf8'), /"auth","status","--json"/);
});

test('signOut runs auth logout and reports ok', async () => {
  const execFileFn = async () => ({ stdout: '' });
  const r = await signOut('claude', { execFileFn });
  assert.equal(r.ok, true);
});
```

> Note: fix the `await import` inside the arrow in `fakeBin` to an `async` IIFE if your Node flags it; the intent is "run the stub via `process.execPath`". A simpler equivalent: set `execFileFn` to `(bin,args,o)=>execFileP(process.execPath,[stub,sf,...args],o)` importing `execFileP` at top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test panel/daemon/test/auth.test.mjs`
Expected: FAIL — `signOut is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to panel/daemon/auth.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test panel/daemon/test/auth.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add panel/daemon/auth.js panel/daemon/test/
git commit -m "feat(auth): signOut() + real-arg integration tests via fake claude"
```

---

### Task 4: Daemon wiring — route the four auth messages

**Files:**
- Modify: `panel/daemon/panel-bridge.js` (after the `auth_mcp` case, ~line 93)
- Modify: `panel/daemon/index.js` (after `bridge.onAuthMcp`, ~line 42)
- Test: `panel/daemon/test/auth.test.mjs`

**Interfaces:**
- Consumes: `authStatus`, `signIn`, `signOut` (Tasks 1–3); `findClaudeBinary()` from `claude-binary.js`.
- Produces (daemon→panel): `auth_status {loggedIn,email,orgName,plan,authMethod}`, `sign_in_started {}`, `sign_in_done {ok,error}`. Consumes (panel→daemon): `auth_status`, `sign_in {mode}`, `sign_out`, `cancel_sign_in`.

- [ ] **Step 1: Add bridge dispatch cases**

In `panel/daemon/panel-bridge.js`, immediately after the `auth_mcp` block:

```js
          if (msg.type === 'auth_status') { if (this.onAuthStatus) this.onAuthStatus(socket); return; }
          if (msg.type === 'sign_in') { if (this.onSignIn) this.onSignIn(msg, socket); return; }
          if (msg.type === 'sign_out') { if (this.onSignOut) this.onSignOut(socket); return; }
          if (msg.type === 'cancel_sign_in') { if (this.onCancelSignIn) this.onCancelSignIn(); return; }
```

- [ ] **Step 2: Add index.js handlers**

At the top of `panel/daemon/index.js`, add `import { authStatus, signIn, signOut } from './auth.js';` and `import { findClaudeBinary } from './claude-binary.js';` (reuse if already imported). After `bridge.onAuthMcp = …`:

```js
let activeSignIn = null;
function sendAuthStatus(socket, s) {
  if (socket && socket.readyState === 1)
    socket.send(JSON.stringify({ type: 'auth_status', loggedIn: s.loggedIn,
      email: s.email, orgName: s.orgName, plan: s.subscriptionType, authMethod: s.authMethod }));
}
bridge.onAuthStatus = async (socket) => {
  try { sendAuthStatus(socket, await authStatus(await findClaudeBinary())); }
  catch (e) { sendAuthStatus(socket, { loggedIn: null }); }
};
bridge.onSignIn = async (msg, socket) => {
  if (activeSignIn) return;
  let bin; try { bin = await findClaudeBinary(); }
  catch (e) { socket.send(JSON.stringify({ type: 'sign_in_done', ok: false, error: e.message })); return; }
  const mode = msg.mode === 'console' ? 'console' : 'claudeai';
  activeSignIn = signIn(bin, mode, { onStarted: () => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'sign_in_started' }));
  }});
  const r = await activeSignIn.done;
  activeSignIn = null;
  if (socket.readyState === 1) {
    socket.send(JSON.stringify({ type: 'sign_in_done', ok: r.ok, error: r.error }));
    if (r.ok && r.status) sendAuthStatus(socket, r.status);
    else sendAuthStatus(socket, await authStatus(bin));
  }
};
bridge.onSignOut = async (socket) => {
  try { await signOut(await findClaudeBinary()); } catch (e) {}
  sendAuthStatus(socket, { loggedIn: false });
};
bridge.onCancelSignIn = () => { if (activeSignIn) { activeSignIn.cancel(); activeSignIn = null; } };
```

- [ ] **Step 3: Test the wiring shape (bridge dispatch)**

```js
// add to panel/daemon/test/auth.test.mjs — verify the bridge calls the right callback
import { PanelBridge } from '../panel-bridge.js';   // adjust to actual export
test('bridge routes sign_in to onSignIn', () => {
  const bridge = new PanelBridge();          // if construction needs args, use the real signature
  let got;
  bridge.onSignIn = (m) => { got = m; };
  bridge._handleMessage({ type: 'sign_in', mode: 'console' }, {}); // adjust to the real dispatch entrypoint
  assert.equal(got.mode, 'console');
});
```

> If `panel-bridge.js` has no unit-testable dispatch entrypoint, SKIP this step and rely on the CDP end-to-end check in Task 7 instead — do not fabricate an entrypoint. Note the skip in the commit message.

- [ ] **Step 4: Run daemon boot smoke-check**

Run: `cd panel/daemon && node -e "import('./index.js').then(()=>console.log('boot ok')).catch(e=>{console.error(e);process.exit(1)})"` then Ctrl-C.
Expected: no import/syntax errors (port-in-use exit is fine).

- [ ] **Step 5: Commit**

```bash
git add panel/daemon/panel-bridge.js panel/daemon/index.js panel/daemon/test/auth.test.mjs
git commit -m "feat(auth): route auth_status/sign_in/sign_out/cancel to auth.js"
```

---

### Task 5: Panel — sign-in card + account chip (markup & CSS)

**Files:**
- Modify: `panel/index.html`

**Interfaces:**
- Produces DOM ids consumed by Task 6: `#signInCard`, `#signInClaude`, `#signInConsole`, `#signInProgress`, `#signInCancel`, `#signInError`, `#accountChip`, `#accountLabel`, `#signOutBtn`.

- [ ] **Step 1: Add the sign-in card markup** inside the chat area (sibling of `#chatMessages`, hidden by default):

```html
<div id="signInCard" class="signin-card" hidden>
  <div class="signin-title">Sign in to Claude</div>
  <div class="signin-sub">Gaffer runs on your Claude account.</div>
  <div class="signin-actions">
    <button id="signInClaude" class="signin-btn primary">Sign in with Claude</button>
    <button id="signInConsole" class="signin-btn">Use Anthropic Console</button>
  </div>
  <div id="signInProgress" class="signin-progress" hidden>
    Complete sign-in in your browser… <button id="signInCancel" class="text-btn">Cancel</button>
  </div>
  <div id="signInError" class="signin-error" hidden></div>
</div>
```

- [ ] **Step 2: Add the account chip** in the "More" drawer settings row (near `#versionText`):

```html
<span id="accountChip" class="account-chip" hidden>
  <span id="accountLabel"></span>
  <button id="signOutBtn" class="text-btn">Sign out</button>
</span>
```

- [ ] **Step 3: Add CSS** (tokens already exist; centered card, muted subtext, primary button uses `--color-btn-primary-bg`):

```css
.signin-card { position: absolute; inset: 0; display: none; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 24px; }
.signin-card.visible { display: flex; }
.signin-title { font-size: 16px; color: var(--color-text-strong); }
.signin-sub { font-size: 12px; color: var(--color-text-muted); }
.signin-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.signin-btn { height: 28px; padding: 0 16px; border: none; border-radius: 8px;
  background: var(--color-border-default); color: var(--color-text-light); cursor: pointer; }
.signin-btn.primary { background: var(--color-btn-primary-bg); color: var(--color-text-white); }
.signin-btn.primary:hover { background: var(--color-btn-primary-hover); }
.signin-progress { font-size: 12px; color: var(--color-text-muted); margin-top: 8px; }
.signin-error { font-size: 12px; color: var(--color-accent-red); margin-top: 8px; }
.account-chip { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-dimmer); }
```

- [ ] **Step 4: Verify it parses** — reload the panel via CDP (`Page.reload`) and confirm no console errors and `document.getElementById('signInCard')` exists (returns non-null).

- [ ] **Step 5: Commit**

```bash
git add panel/index.html
git commit -m "feat(auth): sign-in card + account chip markup/CSS"
```

---

### Task 6: Panel — auth wiring in main.js

**Files:**
- Modify: `panel/main.js`

**Interfaces:**
- Consumes: WS messages from Task 4 and DOM ids from Task 5.
- Produces: `window.__gafferAuth(status)` dev hook (feeds a fake `auth_status` into the state machine) consumed by Task 7.

- [ ] **Step 1: Add auth state + a `renderAuth` function.** Near the top state vars add `var authLoggedIn = null;`. Add:

```js
function renderAuth(s) {
  authLoggedIn = (typeof s.loggedIn === 'boolean') ? s.loggedIn : null;
  var card = document.getElementById('signInCard');
  var chip = document.getElementById('accountChip');
  var signedOut = authLoggedIn === false;
  if (card) card.classList.toggle('visible', signedOut);
  if (card) { card.hidden = false; } // display controlled by .visible
  if (chip) {
    chip.hidden = !(authLoggedIn === true);
    if (authLoggedIn === true) {
      document.getElementById('accountLabel').textContent =
        [s.email, s.orgName, s.plan].filter(Boolean).join(' · ');
    }
  }
  updateChatEnabled();
}
```

- [ ] **Step 2: Gate chat on auth.** Refactor `setStatus`'s enable lines into a shared `updateChatEnabled()` that respects both ws + auth:

```js
function updateChatEnabled() {
  var connected = ledEl.classList.contains('connected');
  var ok = connected && authLoggedIn !== false;
  chatInputEl.disabled = !ok || chatBusy;
  sendBtnEl.disabled = !ok || chatBusy;
}
```
Call `updateChatEnabled()` at the end of `setStatus` (replacing the direct disabled assignments there).

- [ ] **Step 3: Handle the new messages + request on connect.** In the `ws.onmessage` type switch add:

```js
if (msg.type === 'auth_status') { renderAuth(msg); return; }
if (msg.type === 'sign_in_started') {
  document.getElementById('signInProgress').hidden = false;
  document.getElementById('signInError').hidden = true; return;
}
if (msg.type === 'sign_in_done') {
  document.getElementById('signInProgress').hidden = true;
  if (!msg.ok) { var e = document.getElementById('signInError'); e.hidden = false;
    e.textContent = msg.error === 'timeout' ? 'Sign-in timed out — try again.'
      : msg.error === 'cancelled' ? '' : ('Sign-in failed: ' + (msg.error || 'unknown')); }
  return;
}
```
In the WS `onopen` (where `setStatus('connected', …)` fires, ~line 764) add: `ws.send(JSON.stringify({ type: 'auth_status' }));`

- [ ] **Step 4: Wire buttons + dev hook.** In the init/wiring section:

```js
function sendWs(o){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
var b;
if ((b = document.getElementById('signInClaude'))) b.addEventListener('click', function(){ sendWs({type:'sign_in',mode:'claudeai'}); });
if ((b = document.getElementById('signInConsole'))) b.addEventListener('click', function(){ sendWs({type:'sign_in',mode:'console'}); });
if ((b = document.getElementById('signInCancel'))) b.addEventListener('click', function(){ sendWs({type:'cancel_sign_in'}); });
if ((b = document.getElementById('signOutBtn'))) b.addEventListener('click', function(){ sendWs({type:'sign_out'}); });
window.__gafferAuth = function (s) { renderAuth(s || {}); };  // dev/test hook (mirrors __gafferSound)
```

- [ ] **Step 5: Syntax check + commit**

Run: `node --check panel/main.js`
```bash
git add panel/main.js
git commit -m "feat(auth): panel auth state, chat gating, buttons, dev hook"
```

---

### Task 7: Panel state-machine verification via CDP

**Files:**
- Create: `scripts/test-panel-auth.mjs`

**Interfaces:**
- Consumes: `window.__gafferAuth` (Task 6), the daemon `ws` node module for the CDP socket (as used in prior CDP checks).

- [ ] **Step 1: Write the CDP verifier** (drives `window.__gafferAuth` and asserts DOM/gating; reloads first):

```js
// scripts/test-panel-auth.mjs  — run: node scripts/test-panel-auth.mjs
import WebSocket from '../panel/daemon/node_modules/ws/index.js';
const targets = await (await fetch('http://127.0.0.1:13870/json')).json();
const page = targets.find(t => t.type === 'page' && /gaffer/i.test((t.url||'')+(t.title||'')));
if (!page) { console.error('panel not open'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.on('open',r));
let id=0; const rpc=(m,p)=>new Promise(res=>{const i=++id;const h=d=>{const x=JSON.parse(d);if(x.id===i){ws.off('message',h);res(x.result);}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p||{}}));});
await rpc('Page.enable'); await rpc('Runtime.enable'); await rpc('Page.reload');
await new Promise(r=>setTimeout(r,3200));
const ev=e=>rpc('Runtime.evaluate',{returnByValue:true,expression:e}).then(r=>r.result.value);
// signed out → card visible, input disabled
await ev("window.__gafferAuth({loggedIn:false})");
const out = JSON.parse(await ev("JSON.stringify({card:document.getElementById('signInCard').classList.contains('visible'),input:document.getElementById('chatInput').disabled,chip:document.getElementById('accountChip').hidden})"));
// signed in → card hidden, chip shown with label, input enabled (if ws connected)
await ev("window.__gafferAuth({loggedIn:true,email:'a@b.co',orgName:'Acme',plan:'team'})");
const in_ = JSON.parse(await ev("JSON.stringify({card:document.getElementById('signInCard').classList.contains('visible'),chipHidden:document.getElementById('accountChip').hidden,label:document.getElementById('accountLabel').textContent})"));
console.log('SIGNED OUT', out, '\nSIGNED IN', in_);
const pass = out.card===true && out.input===true && out.chip===true && in_.card===false && in_.chipHidden===false && in_.label.includes('a@b.co');
console.log(pass ? 'PASS' : 'FAIL'); process.exit(pass?0:1);
```

- [ ] **Step 2: Run it** (AE panel must be open)

Run: `node scripts/test-panel-auth.mjs`
Expected: `PASS` — signed-out shows card + disables input + hides chip; signed-in hides card + shows chip with `a@b.co · Acme · team`.
Then restore: `node -e "..."` sending `window.__gafferAuth({loggedIn:true, …})` is already the last state; reload once more to clear the injected state.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-panel-auth.mjs
git commit -m "test(auth): CDP panel auth state-machine verification"
```

---

### Task 8: Full-suite run + manual happy-path + deploy gate

**Files:** none (verification only)

- [ ] **Step 1: Run the whole daemon suite** — `node --test panel/daemon/test/` → expect all PASS.
- [ ] **Step 2: Run the panel CDP verifier** — `node scripts/test-panel-auth.mjs` → expect PASS.
- [ ] **Step 3: Manual OAuth happy-path (one-time, needs a signed-out account).** On a machine/account that is signed out: open the panel → the card shows → click "Sign in with Claude" → browser opens → approve → within ~2s of completing, the card dismisses, the account chip shows your email/org/plan, and chat is enabled. Repeat once with "Use Anthropic Console". Record the result here.
- [ ] **Step 4: Deploy gate.** Only if Steps 1–3 all pass: bump `panel/version.json` → 0.6.2, add a CHANGELOG entry, commit, and **then** `git push origin main`. If any step fails, do NOT push — fix and re-run.

---

## Self-Review

**Spec coverage:** detection (`authStatus`/Task 1), sign-in subscription+console (`signIn`/Tasks 2,6), sign-out (Task 3,6), poll/cancel/timeout (Task 2), graceful TTY degradation (Task 2 `degraded`), protocol messages (Task 4), signed-out card + account chip (Tasks 5,6), chat gating incl. `null`-not-blocking (Task 6), no-token security (whole design — Gaffer only invokes `auth *`), testing plan + deploy gate (Tasks 7,8). All spec sections map to a task.

**Placeholder scan:** no TBD/TODO. Two explicit conditional-skip notes (Task 3 `fakeBin` await-shape; Task 4 Step 3 bridge entrypoint) are guarded with concrete fallbacks, not vague deferrals.

**Type consistency:** `authStatus → {loggedIn,authMethod,email,orgName,subscriptionType}` used consistently; daemon maps `subscriptionType→plan` in `sendAuthStatus` (Task 4), and the panel reads `s.plan` (Task 6) — consistent. `signIn` returns `{ok,status,error,degraded}` (Task 2) consumed in Task 4. Mode values `'claudeai'|'console'` consistent across Tasks 2/4/6.
