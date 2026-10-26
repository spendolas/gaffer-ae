import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSitemap, PAGES } from './build-sitemap.mjs';

const site = fileURLToPath(new URL('../../site/', import.meta.url));
const read = (f) => readFileSync(join(site, f), 'utf8');

test('sitemap lists every page on the CNAME host with the given date, and rejects bad input', () => {
  const host = read('CNAME').trim();
  assert.equal(host, 'gafferae.com');
  const xml = renderSitemap(host, '2026-10-20');
  for (const p of PAGES) assert.ok(xml.includes(`<loc>https://gafferae.com${p}</loc>`), p);
  assert.equal((xml.match(/<lastmod>2026-10-20<\/lastmod>/g) || []).length, PAGES.length);
  assert.throws(() => renderSitemap('bad host', '2026-10-20'));
  assert.throws(() => renderSitemap('gafferae.com', '20-10-2026'));
});

test('404 page is self-contained: noindex, absolute asset paths, a way home, no scripts', () => {
  const html = read('404.html');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /url\('\/fonts\/SourceSans3VF-Upright\.otf\.woff2'\)/);
  assert.match(html, /<a href="\/">/);
  assert.doesNotMatch(html, /<script/);
  assert.ok(existsSync(join(site, 'fonts/SourceSans3VF-Upright.otf.woff2')));
});

// Every local reference in the shipped pages and stylesheet points at a file that exists.
function localRefs(text, attrRe) {
  const out = [];
  for (const m of text.matchAll(attrRe)) {
    const ref = m[1];
    if (/^(https?:|data:|mailto:|claude:|claude-cli:|#|\/\/)/.test(ref)) continue;
    out.push(ref.split(/[?#]/)[0]);
  }
  return out;
}

test('index.html references only files that exist', () => {
  const html = read('index.html');
  const refs = localRefs(html, /(?:href|src)="([^"]+)"/g);
  assert.ok(refs.length >= 4);
  for (const r of refs) assert.ok(existsSync(join(site, r)), `index.html: ${r}`);
});

test('site.css url() references exist, resolved from the css folder', () => {
  const css = read('css/site.css');
  const refs = localRefs(css, /url\(\s*['"]?([^'")]+)['"]?\s*\)/g);
  assert.ok(refs.length >= 2);
  for (const r of refs) assert.ok(existsSync(join(site, 'css', r)), `site.css: ${r}`);
});

test('install.md links resolve to known hosts only', () => {
  const md = read('install.md');
  const hosts = new Set([...md.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]));
  const allowed = ['github.com', 'claude.com', 'claude.ai', 'nodejs.org', 'gafferae.com', 'api.github.com', '127.0.0.1', 'release-assets.githubusercontent.com'];
  for (const h of hosts) assert.ok(allowed.includes(h), `unexpected host in install.md: ${h}`);
});

// ---- the page's head: title, description and link-preview tags --------------------------------------------
const head = read('index.html').match(/<head>([\s\S]*?)<\/head>/)[1];
const meta = (attr, name) => {
  const m = head.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`));
  assert.ok(m, `${attr}="${name}" is missing`);
  return m[1];
};

test('title and description have search-friendly lengths and agree with the draft wording', () => {
  const title = head.match(/<title>([^<]*)<\/title>/)[1];
  assert.equal(title, 'Gaffer: your AI crew in After Effects');
  assert.ok(title.length <= 60);
  const desc = meta('name', 'description');
  assert.ok(desc.length >= 120 && desc.length <= 160, `description is ${desc.length} characters`);
  assert.ok(desc.includes('Requires Claude Code'));
  assert.doesNotMatch(title + desc, /[–—]/, 'no en or em dashes in copy');
});

test('Open Graph and Twitter tags are complete, absolute, and match the share image file', () => {
  assert.equal(meta('property', 'og:type'), 'website');
  assert.equal(meta('property', 'og:site_name'), 'Gaffer');
  assert.equal(meta('property', 'og:title'), head.match(/<title>([^<]*)<\/title>/)[1]);
  assert.ok(meta('property', 'og:description').length <= 160);
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta('name', 'twitter:title'), meta('property', 'og:title'));
  assert.equal(meta('name', 'twitter:description'), meta('property', 'og:description'));
  for (const url of [meta('property', 'og:url'), meta('property', 'og:image'), meta('name', 'twitter:image'), head.match(/<link rel="canonical" href="([^"]+)">/)[1]]) {
    assert.match(url, /^https:\/\/gafferae\.com\//, `${url} is absolute https on the real host`);
  }
  assert.equal(meta('property', 'og:image'), meta('name', 'twitter:image'));
  assert.ok(meta('property', 'og:image:alt').length > 20 && meta('property', 'og:image:alt') === meta('name', 'twitter:image:alt'));
  // The declared size and type are the file's real ones.
  const file = readFileSync(join(site, new URL(meta('property', 'og:image')).pathname.slice(1)));
  assert.equal(meta('property', 'og:image:type'), 'image/jpeg');
  assert.equal(file.readUInt16BE(0), 0xFFD8, 'a JPEG');
  let pos = 2, size;
  while (pos < file.length && !size) {
    const marker = file[pos + 1], len = file.readUInt16BE(pos + 2);
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) size = { h: file.readUInt16BE(pos + 5), w: file.readUInt16BE(pos + 7) };
    pos += 2 + len;
  }
  assert.equal(String(size.w), meta('property', 'og:image:width'));
  assert.equal(String(size.h), meta('property', 'og:image:height'));
});

test('robots meta allows indexing and large image previews; the page names itself for home screens', () => {
  assert.equal(meta('name', 'robots'), 'index, follow, max-image-preview:large');
  assert.equal(meta('name', 'application-name'), 'Gaffer');
  assert.equal(meta('name', 'apple-mobile-web-app-title'), 'Gaffer');
  assert.match(head, /<link rel="alternate" type="text\/markdown" href="\/install\.md"/);
});

// robots.txt: Cowork-style fetchers obey it, and treat an error on it as "everything disallowed". So the
// install page and the home page must stay allowed for every agent, only the clip folder is off-limits.
function robotsAllows(txt, agent, path) {
  const groups = [];
  let cur = null;
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'user-agent') {
      if (!cur || cur.rules.length) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(m[2].toLowerCase());
    } else if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push([k, m[2]]);
  }
  const g = groups.find((x) => x.agents.includes(agent.toLowerCase())) || groups.find((x) => x.agents.includes('*'));
  if (!g) return true;
  let best = { len: -1, allow: true };
  for (const [k, p] of g.rules) {
    if (p && path.startsWith(p) && p.length > best.len) best = { len: p.length, allow: k === 'allow' };
  }
  return best.allow;
}

test('robots.txt keeps the pages open to every agent, the clips off-limits, and lists the sitemap', () => {
  const txt = read('robots.txt');
  const agents = ['*', 'Claude-User', 'ClaudeBot', 'Claude-SearchBot', 'ChatGPT-User', 'GPTBot', 'OAI-SearchBot', 'Googlebot', 'CCBot'];
  for (const a of agents) {
    assert.ok(robotsAllows(txt, a, '/install.md'), `${a} /install.md`);
    assert.ok(robotsAllows(txt, a, '/'), `${a} /`);
    assert.ok(robotsAllows(txt, a, '/og.jpg'), `${a} /og.jpg`);
    assert.ok(!robotsAllows(txt, a, '/media/clip-01.mp4'), `${a} /media/`);
  }
  assert.match(txt, /^Sitemap: https:\/\/gafferae\.com\/sitemap\.xml$/m);
});

test('structured data parses, is free, names the publisher, and every URL is absolute https', () => {
  const raw = head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  const graph = JSON.parse(raw)['@graph'];
  const app = graph.find((n) => n['@type'] === 'SoftwareApplication');
  assert.equal(app.offers.price, '0');
  assert.equal(app.publisher.name, 'spendolas');
  assert.match(app.softwareRequirements, /Claude Code/);
  for (const url of raw.match(/"https?:[^"]+"/g)) assert.match(url, /^"https:\/\//, url);
  assert.ok(existsSync(join(site, new URL(app.image).pathname.slice(1))));
});

test('security.txt has a contact, an unexpired date under a year out, and its own canonical URL', () => {
  const txt = read('.well-known/security.txt');
  assert.match(txt, /^Contact: https:\/\/github\.com\/spendolas\/gaffer-ae\/security\/advisories\/new$/m);
  assert.match(txt, /^Canonical: https:\/\/gafferae\.com\/\.well-known\/security\.txt$/m);
  const exp = new Date(/^Expires: (\S+)$/m.exec(txt)[1]);
  const days = (exp - Date.now()) / 864e5;
  assert.ok(days > 30 && days < 366, `expires in ${Math.round(days)} days: renew security.txt`);
});

test('llms.txt links the install page and the source, all absolute https', () => {
  const txt = read('llms.txt');
  assert.match(txt, /\]\(https:\/\/gafferae\.com\/install\.md\)/);
  assert.match(txt, /\]\(https:\/\/github\.com\/spendolas\/gaffer-ae\)/);
  for (const m of txt.matchAll(/\]\(([^)]+)\)/g)) assert.match(m[1], /^https:\/\//);
});

test('every published clip carries its title, description and copyright from clip-meta.json', () => {
  const ff = spawnSync('ffprobe', ['-version']);
  if (ff.error) return; // no ffprobe on this machine: the CI runner has it
  const meta = JSON.parse(readFileSync(new URL('./clip-meta.json', import.meta.url), 'utf8'));
  const ids = readdirSync(join(site, 'media')).filter((n) => /^clip-\d+\.mp4$/.test(n)).map((n) => n.slice(0, -4));
  assert.deepEqual(Object.keys(meta).sort(), ids.sort(), 'clip-meta.json lists exactly the published clips');
  for (const id of ids) {
    for (const f of [`${id}.mp4`, `${id}.hevc.mp4`]) {
      const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title,description,copyright', '-of', 'json', join(site, 'media', f)], { encoding: 'utf8' }).stdout;
      const tags = JSON.parse(out).format.tags;
      assert.equal(tags.title, meta[id].title, f);
      assert.equal(tags.description, meta[id].description, f);
      assert.equal(tags.copyright, `© 2026 ${meta[id].holder}. All rights reserved.`, f);
    }
  }
  assert.equal(meta['clip-06'].holder, 'João Veríssimo');
});
