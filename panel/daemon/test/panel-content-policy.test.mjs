// Wiring checks for how the panel shows untrusted text: the content policy in
// index.html, the script order, and that main.js has no raw path from chat
// content to innerHTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL('../../' + rel, import.meta.url)), 'utf8');
const html = read('index.html');
const main = read('main.js');

function policy() {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'index.html carries a Content-Security-Policy meta');
  const out = {};
  for (const part of m[1].split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out[name] = vals;
  }
  return out;
}

test('policy: nothing is allowed unless listed, and no remote script, frame, object or form target', () => {
  const p = policy();
  assert.deepEqual(p['default-src'], ["'none'"]);
  assert.deepEqual(p['script-src'], ["'self'"]);
  assert.deepEqual(p['frame-src'], ["'none'"]);
  assert.deepEqual(p['object-src'], ["'none'"]);
  assert.deepEqual(p['base-uri'], ["'none'"]);
  assert.deepEqual(p['form-action'], ["'none'"]);
  for (const d of ['script-src', 'default-src']) assert.ok(!p[d].includes("'unsafe-inline'") && !p[d].includes("'unsafe-eval'"), d);
});

test('policy: images are local or inline only (no remote image requests)', () => {
  const p = policy();
  assert.deepEqual(p['img-src'].slice().sort(), ["'self'", 'blob:', 'data:']);
  assert.deepEqual(p['media-src'].slice().sort(), ["'self'", 'blob:', 'data:']);
  assert.deepEqual(p['font-src'], ["'self'"]);
});

test('policy: the only network targets are the daemon socket and the update check', () => {
  const p = policy();
  assert.deepEqual(p['connect-src'].slice().sort(), ['https://api.github.com', 'ws://127.0.0.1:9823']);
  assert.ok(main.includes("var WS_URL = 'ws://127.0.0.1:9823'"), 'WS_URL matches the policy');
  assert.ok(main.includes("'https://api.github.com/repos/spendolas/gaffer-ae/releases/latest'"), 'update URL matches the policy');
  const hosts = new Set([...main.matchAll(/\b(?:fetch|new WebSocket)\(\s*([A-Za-z_.]+|'[^']+')/g)].map((m) => m[1]));
  assert.deepEqual([...hosts].sort(), ['RELEASES_LATEST_URL', 'WS_URL']);
});

test('policy: the page has no inline script or inline event handler for script-src to block', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<style[\s\S]*?<\/style>/gi, '')), 'inline on* attribute');
  assert.ok(!/javascript:/i.test(html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '')), 'javascript: URL');
});

test('scripts: the renderer loads after marked and before main.js', () => {
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(order.indexOf('lib/marked.min.js') >= 0);
  assert.ok(order.indexOf('lib/safe-markdown.js') > order.indexOf('lib/marked.min.js'));
  assert.ok(order.indexOf('lib/safe-markdown.js') < order.indexOf('main.js'));
});

test('main.js: chat text only reaches innerHTML through the safe renderer', () => {
  assert.ok(!/\bmarked\.parse\b/.test(main), 'no direct marked.parse');
  assert.ok(!/atob\(/.test(main), 'no decoded remote markup (tile icons use an image mask)');
  assert.match(main, /SafeMarkdown\.render\(text\)/);
  assert.match(main, /SafeMarkdown\.sanitizeHtml\(html\)/);
  assert.match(main, /SafeMarkdown\.attachLinkHandler\(document, openExternal\)/);
  // every innerHTML assignment is one of: empty, a fixed literal, a bundled icon, or a filtered value
  const sinks = [...main.matchAll(/\.innerHTML\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim());
  for (const rhs of sinks) {
    const ok = /^''$/.test(rhs) || /^'<i><\/i><i><\/i><i><\/i>'$/.test(rhs) || /^'<span class="mcp-loading">loading…<\/span>'$/.test(rhs)
      || /^\(typeof GafferIcons/.test(rhs) || /^GafferIcons[.\[]/.test(rhs) || /^GafferIcons\.\w+ \|\| ''$/.test(rhs)
      || /^renderMarkdown\(/.test(rhs) || /^q\.html \? safeHtml\(q\.html\)/.test(rhs);
    assert.ok(ok, 'unexpected innerHTML source: ' + rhs);
  }
});

test('main.js: tool pills are found by comparing ids, not by building a selector', () => {
  assert.ok(!/querySelector\('\[data-tool-id=/.test(main));
});

test('main.js: reply quotes are filtered when captured and again when built', () => {
  assert.match(main, /return \{ html: safeHtml\(box\.innerHTML\), text: text \};/);
  assert.match(main, /txt\.innerHTML = q\.html \? safeHtml\(q\.html\)/);
});
