import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plannedImages, exiftoolArgs, rights } from './tag-images.mjs';

const site = fileURLToPath(new URL('../../site/', import.meta.url));
const readJson = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));
const assetMeta = readJson('./asset-meta.json');
const clipMeta = readJson('./clip-meta.json');
const hasExiftool = !spawnSync('exiftool', ['-ver']).error;

test('plannedImages covers the share image, the PNG icons and one poster per clip, and rejects an unknown clip', () => {
  const planned = plannedImages(assetMeta, clipMeta, ['clip-06']);
  assert.deepEqual(planned.map((p) => p.file), ['og.jpg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png', 'media/_generated/clip-06.jpg']);
  const poster = planned.at(-1);
  assert.equal(poster.holder, 'João Veríssimo');
  assert.equal(poster.title, 'Time scrubber (poster frame)');
  assert.match(poster.description, /^Poster frame of the clip: A glass handle/);
  assert.throws(() => plannedImages(assetMeta, clipMeta, ['clip-99']), /clip-99/);
});

test('exiftoolArgs strips first, writes XMP everywhere and IPTC/EXIF only for JPEG, in UTF-8', () => {
  const jpg = exiftoolArgs({ file: 'og.jpg', title: 'T', description: 'D', holder: 'João' }, 2026, 'https://gafferae.com/');
  const png = exiftoolArgs({ file: 'icon.png', title: 'T', description: 'D', holder: 'João' }, 2026, 'https://gafferae.com/');
  assert.ok(jpg.indexOf('-all=') < jpg.indexOf('-XMP-dc:Title=T'), 'strips before writing');
  assert.ok(jpg.includes('-IPTC:CodedCharacterSet=UTF8') && jpg.includes(`-EXIF:Copyright=${rights(2026, 'João')}`));
  assert.ok(png.includes(`-XMP-dc:Rights=${rights(2026, 'João')}`));
  assert.ok(!png.some((a) => a.startsWith('-IPTC:') || a.startsWith('-EXIF:')));
});

test('icon.svg describes itself with a title and a description', () => {
  const svg = readFileSync(join(site, 'icon.svg'), 'utf8');
  assert.ok(svg.includes(`<title>${assetMeta.files['icon.svg'].title}</title>`));
  assert.ok(svg.includes(`<desc>${assetMeta.files['icon.svg'].description}</desc>`));
});

// Published images carry exactly the planned tags: title, description, creator, rights, source, and nothing
// that names a person's computer. Posters are generated at deploy, so they are checked only when present.
test('every published image carries its planned tags and leaks nothing', { skip: !hasExiftool && 'no exiftool on this machine (the CI runner installs it)' }, () => {
  const gen = join(site, 'media', '_generated');
  const ids = existsSync(gen) ? readdirSync(gen).filter((n) => /^clip-\d+\.jpg$/.test(n)).map((n) => n.slice(0, -4)) : [];
  for (const p of plannedImages(assetMeta, clipMeta, ids)) {
    const out = spawnSync('exiftool', ['-j', '-a', '-G1', '-charset', 'iptc=UTF8', join(site, p.file)], { encoding: 'utf8' }).stdout;
    const tags = JSON.parse(out)[0];
    const get = (k) => tags[k];
    assert.equal(get('XMP-dc:Title'), p.title, p.file);
    assert.equal(get('XMP-dc:Description'), p.description, p.file);
    assert.equal(get('XMP-dc:Creator'), p.holder, p.file);
    assert.equal(get('XMP-dc:Rights'), rights(assetMeta.year, p.holder), p.file);
    assert.equal(get('XMP-dc:Source'), assetMeta.url, p.file);
    if (p.file.endsWith('.jpg')) {
      assert.equal(get('IPTC:CopyrightNotice'), rights(assetMeta.year, p.holder), p.file);
      assert.equal(get('IFD0:Copyright'), rights(assetMeta.year, p.holder), p.file);
    }
    const planned = /^(XMP-dc|XMP-xmpRights|IPTC|IFD0|XMP-x):/;
    for (const [k, v] of Object.entries(tags)) {
      if (k === 'SourceFile' || /^(ExifTool|System|File|Composite|PNG|JFIF|ICC_Profile|Photoshop|APP14|Adobe):/.test(k)) continue;
      assert.match(k, planned, `${p.file}: unplanned tag ${k}`);
      assert.doesNotMatch(String(v), /\/Users\/|\\Users\\|\.local|\.ts\.net|grater|Library\/|Dropbox/i, `${p.file}: ${k} leaks a path or host`);
    }
    assert.equal(get('File:Comment'), undefined, `${p.file}: encoder comment survived`);
  }
});
