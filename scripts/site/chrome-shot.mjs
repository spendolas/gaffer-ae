// Renders HTML (or an SVG inside it) to PNG/JPEG with the installed Google Chrome, so generated images are
// exactly what a browser draws. Shared by build-icons.mjs and build-og.mjs. Needs Chrome and the `ws`
// package from panel/daemon/node_modules (a git worktree has none, so the main checkout is searched too).
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function loadWs() {
  const candidates = [join(root, 'panel/daemon/')];
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    candidates.push(join(dirname(common), 'panel/daemon/'));
  } catch { /* not a git checkout */ }
  for (const dir of candidates) {
    try { return createRequire(dir)('ws'); } catch { /* try the next */ }
  }
  throw new Error('the ws package is not installed: run npm install in panel/daemon (or use a checkout that has it)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn({ shot }) with a Chrome open. shot({ htmlFile | html, width, height, format, quality, transparent })
// returns a Buffer. htmlFile is an absolute path (file:// pages may load local fonts and images).
export async function withChrome(fn) {
  const WebSocket = loadWs();
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-shot-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--hide-scrollbars', '--allow-file-access-from-files'], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { if (i > 60) throw new Error('Chrome did not start'); await sleep(200); }
    }
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => ws.on('open', r));
    let id = 0;
    const pending = new Map();
    ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

    async function shot({ htmlFile, html, width, height, format = 'png', quality = 90, transparent = false, settleMs = 600 }) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setDefaultBackgroundColorOverride', { color: transparent ? { r: 0, g: 0, b: 0, a: 0 } : { r: 18, g: 18, b: 18, a: 1 } });
      const url = htmlFile ? pathToFileURL(htmlFile).href : `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
      await send('Page.navigate', { url });
      await sleep(settleMs);
      await send('Runtime.evaluate', { expression: 'document.fonts ? document.fonts.ready.then(() => true) : true', awaitPromise: true });
      const params = { format, clip: { x: 0, y: 0, width, height, scale: 1 }, fromSurface: true };
      if (format === 'jpeg') params.quality = quality;
      const res = await send('Page.captureScreenshot', params);
      return Buffer.from(res.result.data, 'base64');
    }
    return await fn({ shot });
  } finally {
    await new Promise((r) => { chrome.once('exit', r); chrome.kill(); });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
