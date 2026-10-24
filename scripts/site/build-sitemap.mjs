// Writes site/sitemap.xml (generated at deploy, never committed): the pages worth indexing, each with
// today's date as <lastmod>. The host comes from site/CNAME, so a domain change needs no edit here.
//   node scripts/site/build-sitemap.mjs [YYYY-MM-DD]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGES = ['/', '/install.md'];

export function renderSitemap(host, date) {
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error(`bad host: ${host}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date: ${date}`);
  const urls = PAGES.map((p) => `  <url>\n    <loc>https://${host}${p}</loc>\n    <lastmod>${date}</lastmod>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = readFileSync(join(root, 'site', 'CNAME'), 'utf8').trim();
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  writeFileSync(join(root, 'site', 'sitemap.xml'), renderSitemap(host, date));
  console.log(`wrote site/sitemap.xml for ${host} (${date})`);
}
