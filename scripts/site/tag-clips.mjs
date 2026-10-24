// Applies scripts/site/clip-meta.json (title, description, copyright holder) to every clip in site/media,
// both the H.264 and the HEVC file, with no re-encode. Run after editing the JSON, then rebuild the manifest.
//   node scripts/site/tag-clips.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const meta = JSON.parse(readFileSync(join(root, 'scripts/site/clip-meta.json'), 'utf8'));
for (const [id, m] of Object.entries(meta)) {
  for (const ext of ['mp4', 'hevc.mp4']) {
    execFileSync(join(root, 'scripts/site/tag-clip.sh'), [join(root, 'site/media', `${id}.${ext}`), m.holder, m.title, m.description], { stdio: 'inherit' });
  }
  console.log(`tagged ${id}`);
}
