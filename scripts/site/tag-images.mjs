// Writes the title, description, creator and copyright into every published image, with exiftool:
//   og.jpg and the PNG icons (committed, so run this after build-icons.mjs / figma-export-og.mjs and commit),
//   and the poster frames in site/media/_generated (generated at deploy, tagged by the workflow).
// Text comes from scripts/site/asset-meta.json (icons, share image) and clip-meta.json (posters, which take
// their clip's title, description and holder). Existing tags are stripped first, so the only tags a file keeps
// are the ones planned here (the encoder comment ffmpeg leaves in a poster goes). icon.svg carries its text in
// <title> and <desc> (build-icons.mjs); favicon.ico has no metadata fields.
//   node scripts/site/tag-images.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

export const rights = (year, holder) => `© ${year} ${holder}. All rights reserved.`;

// The planned entries as [{ file, title, description, holder }], files relative to site/.
export function plannedImages(assetMeta, clipMeta, posterIds) {
  const out = [];
  for (const [file, m] of Object.entries(assetMeta.files)) {
    if (!file.endsWith('.svg')) out.push({ file, ...(m.same ? assetMeta.files[m.same] : m) });
  }
  for (const id of posterIds) {
    const c = clipMeta[id];
    if (!c) throw new Error(`poster ${id} has no entry in clip-meta.json`);
    out.push({
      file: `media/_generated/${id}.jpg`,
      title: `${c.title}${assetMeta.posters.titleSuffix}`,
      description: `${assetMeta.posters.descriptionPrefix}${c.description}`,
      holder: c.holder,
    });
  }
  return out;
}

// exiftool arguments for one image. Strips everything, then writes XMP (every format) and, for JPEG, the
// IPTC and EXIF fields too, in UTF-8 so names such as Veríssimo survive.
export function exiftoolArgs({ file, title, description, holder }, year, url) {
  const text = rights(year, holder);
  const args = [
    '-overwrite_original', '-charset', 'iptc=UTF8', '-charset', 'exif=UTF8', '-all=',
    `-XMP-dc:Title=${title}`, `-XMP-dc:Description=${description}`, `-XMP-dc:Creator=${holder}`,
    `-XMP-dc:Rights=${text}`, `-XMP-dc:Source=${url}`, '-XMP-xmpRights:Marked=True', `-XMP-xmpRights:WebStatement=${url}`,
  ];
  if (/\.jpe?g$/i.test(file)) {
    args.push('-IPTC:CodedCharacterSet=UTF8', `-IPTC:ObjectName=${title}`, `-IPTC:Caption-Abstract=${description}`, `-IPTC:By-line=${holder}`,
      `-IPTC:CopyrightNotice=${text}`, `-EXIF:ImageDescription=${description}`, `-EXIF:Artist=${holder}`, `-EXIF:Copyright=${text}`);
  }
  return args;
}

export function tagImages(siteDir = join(root, 'site')) {
  const assetMeta = readJson('scripts/site/asset-meta.json');
  const clipMeta = readJson('scripts/site/clip-meta.json');
  const genDir = join(siteDir, 'media', '_generated');
  const posterIds = existsSync(genDir) ? readdirSync(genDir).filter((n) => /^clip-\d+\.jpg$/.test(n)).map((n) => n.slice(0, -4)).sort() : [];
  const planned = plannedImages(assetMeta, clipMeta, posterIds);
  for (const p of planned) {
    execFileSync('exiftool', [...exiftoolArgs(p, assetMeta.year, assetMeta.url), join(siteDir, p.file)], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return planned.map((p) => p.file);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = tagImages();
  console.log(`tagged ${files.length} images: ${files.join(', ')}`);
}
