#!/usr/bin/env node
// Builds site/items.json from the clips in site/media.
// Item = { id, video, poster, hevc?, webm?, width, height }, all paths site-relative and URL-safe, each with a ?v=<content hash> stamp.
// <stem>.hevc.mp4 is the HEVC companion of <stem>.mp4, never a clip of its own.
import { readdirSync, existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const URL_SAFE = /^[A-Za-z0-9._-]+$/;
const HEVC_EXT = '.hevc.mp4';
const isHevc = (f) => f.toLowerCase().endsWith(HEVC_EXT);

// Lowercase ASCII slug. Accents are folded (Café -> cafe); anything with no ASCII
// letters or digits (e.g. CJK) slugs to '' and becomes 'clip'.
export function slugify(stem) {
  const s = stem.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'clip';
}

async function exec(bin, args, label) {
  try {
    return (await run(bin, args)).stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${label} not found (tried "${bin}"). Install ffmpeg (it includes ffprobe) or pass its path.`);
    }
    throw err;
  }
}

export async function buildManifest({ mediaDir, outFile, ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe' }) {
  const files = readdirSync(mediaDir)
    .filter((f) => extname(f).toLowerCase() === '.mp4' && !isHevc(f)).sort();
  const genDir = join(mediaDir, '_generated');
  const used = new Set();
  const items = [];

  // Site-relative path for a media file; files whose names are not URL-safe are
  // copied to _generated/<id><ext> so the path survives encodeURI unchanged.
  const publish = (file, id, ext = extname(file).toLowerCase()) => {
    if (URL_SAFE.test(file)) return `media/${file}`;
    mkdirSync(genDir, { recursive: true });
    copyFileSync(join(mediaDir, file), join(genDir, `${id}${ext}`));
    return `media/_generated/${id}${ext}`;
  };

  // Content stamp: media/clip-01.mp4 becomes media/clip-01.mp4?v=<8 hex of the file's sha1>, so a clip
  // replaced under the same name gets a new address and no cache (CDN, browser) can serve the old one.
  const siteDir = dirname(mediaDir);
  const stamp = (rel) => `${rel}?v=${createHash('sha1').update(readFileSync(join(siteDir, rel))).digest('hex').slice(0, 8)}`;

  for (const file of files) {
    const stem = basename(file, extname(file));
    // Collisions: first file in filename order keeps the slug, later ones get -2, -3, ...
    const base = slugify(stem);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);

    const src = join(mediaDir, file);
    let width, height;
    try {
      const out = await exec(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', src], 'ffprobe');
      [width, height] = out.trim().split('x').map(Number);
    } catch (err) {
      if (/not found/.test(err.message)) throw err;
      throw new Error(`Cannot read video ${file}: ${err.stderr || err.message}`);
    }
    if (!(width > 0 && height > 0)) throw new Error(`Cannot read video ${file}: no video stream`);

    let poster;
    if (existsSync(join(mediaDir, `${id}.jpg`))) {
      poster = `media/${id}.jpg`;
    } else {
      mkdirSync(genDir, { recursive: true });
      try {
        await exec(ffmpegBin, ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-q:v', '3',
          join(genDir, `${id}.jpg`)], 'ffmpeg');
      } catch (err) {
        if (/not found/.test(err.message)) throw err;
        throw new Error(`Cannot make a poster for ${file}: ${err.stderr || err.message}`);
      }
      poster = `media/_generated/${id}.jpg`;
    }

    const item = { id, video: stamp(publish(file, id)), poster: stamp(poster), width, height };
    const hevcFile = `${stem}${HEVC_EXT}`;
    if (existsSync(join(mediaDir, hevcFile))) item.hevc = stamp(publish(hevcFile, id, HEVC_EXT));
    const webmFile = `${stem}.webm`;
    if (existsSync(join(mediaDir, webmFile))) item.webm = stamp(publish(webmFile, id));
    items.push(item);
  }

  writeFileSync(outFile, JSON.stringify(items, null, 2) + '\n');
  return items;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const [mediaDir = join(root, 'site', 'media'), outFile = join(root, 'site', 'items.json')] = process.argv.slice(2);
  buildManifest({ mediaDir, outFile }).then(
    (items) => console.log(`Wrote ${items.length} items to ${outFile}`),
    (err) => { console.error(err.message); process.exit(1); },
  );
}
