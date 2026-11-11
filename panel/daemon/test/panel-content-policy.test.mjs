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

// Static scan of main.js for ways text can become markup or a navigation target.
// Returns a list of problems; exported-style so the negative tests below can feed
// it deliberately bad snippets and prove it fails.
const norm = (t) => t.replace(/\s+/g, ' ').trim();
const INNER_OK = [
  /^''$/,
  /^'<i><\/i><i><\/i><i><\/i>'$/,
  /^'<span class="mcp-loading">loading…<\/span>'$/,
  /^\(typeof GafferIcons !== 'undefined' && GafferIcons\[name\]\) \|\| ''$/,
  /^GafferIcons\.\w+( \|\| '')?$/,
  /^GafferIcons\[expanded \? 'chevronUp' : 'chevronDown'\]$/,
  /^renderMarkdown\((msg\.text|t)\)$/,
  /^typeof q\.html === 'string' && q\.html \? safeHtml\(q\.html\) : escapeHtml\(q\.text \|\| ''\)$/,
];
// .src assignments are allowed only next to the check that makes them safe.
const SRC_OK = [
  { rhs: /^url$/, near: /createObjectURL/ },
  { rhs: /^item\.dataUrl$/, near: /isImageDataUrl\(item\.dataUrl\)/ },
  { rhs: /^dataUrl$/, near: /isImageDataUrl\(dataUrl\)/ },
];
function scanMain(src) {
  const problems = [];
  for (const re of [/\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write(ln)?\b/, /\bcreateContextualFragment\b/, /\bDOMParser\b/,
    /\binnerHTML\s*\+=/, /\[\s*['"]innerHTML['"]\s*\]/, /\bsrcdoc\b/, /\beval\s*\(/, /\bnew Function\b/, /\bwindow\.open\s*\(/, /\blocation\s*(\.href)?\s*=[^=]/,
    /\.href\s*=[^=]/, /\.setAttribute\(\s*['"](?:src|href|srcdoc|style|on\w+)['"]/, /\.(?:style\.)?(?:webkitM|m)askImage\s*=(?!\s*'url\("' \+ iconUrl \+ '"\)';)/]) {
    const m = re.exec(src);
    if (m) problems.push('forbidden: ' + m[0]);
  }
  for (const m of src.matchAll(/\.innerHTML\s*=(?!=)\s*([^;]*);/g)) {
    const rhs = norm(m[1]);
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    const viaStream = rhs === 'html' && /createStreamRenderer\(function \(html\) \{\s*[\w.]*$/.test(before);
    if (!viaStream && !INNER_OK.some((re) => re.test(rhs))) problems.push('innerHTML source not allowed: ' + rhs);
  }
  for (const m of src.matchAll(/\.src\s*=(?!=)\s*([^;]*);/g)) {
    const rhs = norm(m[1]);
    const before = src.slice(Math.max(0, m.index - 1000), m.index + m[0].length);
    if (!SRC_OK.some((o) => o.rhs.test(rhs) && o.near.test(before))) problems.push('src source not allowed: ' + rhs);
  }
  return problems;
}

test('main.js: chat text only reaches innerHTML through the safe renderer', () => {
  assert.ok(!/\bmarked\.parse\b/.test(main), 'no direct marked.parse');
  assert.ok(!/atob\(/.test(main), 'no decoded remote markup (tile icons use an image mask)');
  assert.match(main, /SafeMarkdown\.render\(text\)/);
  assert.match(main, /SafeMarkdown\.sanitizeHtml\(html\)/);
  assert.match(main, /SafeMarkdown\.attachLinkHandler\(document, openExternal\)/);
  assert.deepEqual(scanMain(main), []);
});

test('scan: every innerHTML and src assignment in main.js was seen (the scan is not vacuous)', () => {
  const inner = [...main.matchAll(/\.innerHTML\s*=(?!=)\s*([^;]*);/g)].length;
  // any other mention of .innerHTML is a read of our own, already filtered, DOM
  const reads = [...main.matchAll(/\.innerHTML\b(?!\s*=(?!=))/g)].filter((m) => !/^\s*(\/\/|\*)/.test(main.slice(main.lastIndexOf('\n', m.index) + 1, m.index)));
  for (const m of reads) assert.match(main.slice(m.index - 20, m.index + 12), /safeHtml\(box\.innerHTML\)/, 'unexpected innerHTML read');
  assert.ok([...main.matchAll(/\.src\s*=(?!=)\s*([^;]*);/g)].length >= 4);
});

test('scan: deliberately unsafe snippets are reported', () => {
  const bad = [
    'document.body.insertAdjacentHTML("beforeend", m.text);',
    'el.innerHTML += m.text;',
    'el.innerHTML = renderMarkdown(m.a) + m.text;',
    'el.innerHTML = m.text;',
    'el.innerHTML =\n  m.text;',
    'el.outerHTML = m.text;',
    "el['innerHTML'] = m.text;",
    'document.write(m.text);',
    'range.createContextualFragment(m.text);',
    'new DOMParser().parseFromString(m.text, "text/html");',
    'img.src = m.url;',
    'a.href = m.url;',
    "el.setAttribute('href', m.url);",
    "el.setAttribute('onclick', m.code);",
    "iframe.srcdoc = m.text;",
    'location.href = m.url;',
    'window.open(m.url);',
    'eval(m.text);',
    "span.style.webkitMaskImage = 'url(\"' + m.icon + '\")';",
  ];
  for (const snippet of bad) assert.notDeepEqual(scanMain(snippet), [], snippet);
  // and the real code shape stays accepted
  const good = [
    "el.innerHTML = '';",
    'el.innerHTML = renderMarkdown(msg.text);',
    "if (isImageDataUrl(item.dataUrl)) img.src = item.dataUrl;",
    "span.style.webkitMaskImage = 'url(\"' + iconUrl + '\")';",
  ];
  for (const snippet of good) assert.deepEqual(scanMain(snippet), [], snippet);
});

test('main.js: every drag and drop on the panel is cancelled, so a dropped link or page cannot load into the frame', () => {
  assert.match(main, /document\.addEventListener\('dragover', function \(e\) \{\s*e\.preventDefault\(\);/);
  assert.match(main, /document\.addEventListener\('drop', function \(e\) \{\s*e\.preventDefault\(\);/);
  assert.match(main, /document\.addEventListener\('dragstart', function \(e\) \{[^}]*closest\('a'\)[^}]*preventDefault/);
});

test('main.js: streamed replies are rendered through the throttled stream renderer', () => {
  assert.match(main, /SafeMarkdown\.createStreamRenderer\(/);
  assert.ok(!/textNode\.innerHTML = renderMarkdown\(textNode\.dataset\.raw\)/.test(main), 'no per-chunk full render');
});

test('main.js: tool pills are found by comparing ids, not by building a selector', () => {
  assert.ok(!/querySelector\('\[data-tool-id=/.test(main));
});

test('main.js: reply quotes are filtered when captured and again when built', () => {
  assert.match(main, /return \{ html: safeHtml\(box\.innerHTML\), text: text \};/);
  assert.match(main, /txt\.innerHTML = typeof q\.html === 'string' && q\.html \? safeHtml\(q\.html\)/);
});
