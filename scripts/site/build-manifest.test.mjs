import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from './build-manifest.mjs';

// Manifest paths carry a ?v=<8 hex content hash> stamp.
function assertStamped(actual, path) {
  assert.ok(actual.startsWith(`${path}?v=`), `${actual} should be ${path}?v=<hash>`);
  assert.match(actual.slice(path.length), /^\?v=[0-9a-f]{8}$/);
}

const FFMPEG = existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg';

function makeClip(file, size = '64x48') {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10:duration=0.5`,
    '-pix_fmt', 'yuv420p', '-an', file]);
}

function setup(names = []) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-'));
  const mediaDir = join(root, 'media');
  mkdirSync(mediaDir);
  for (const n of names) makeClip(join(mediaDir, n));
  return { root, mediaDir, outFile: join(root, 'items.json') };
}

test('ordersByFilename', async () => {
  const t = setup(['b.mp4', 'a.mp4', 'c.mp4']);
  const items = await buildManifest(t);
  assert.deepEqual(items.map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(JSON.parse(readFileSync(t.outFile, 'utf8')), items);
  assert.deepEqual([items[0].width, items[0].height], [64, 48]);
  assertStamped(items[0].video, 'media/a.mp4');
  rmSync(t.root, { recursive: true });
});

test('generatesPosterWhenMissing', async () => {
  const t = setup(['a.mp4']);
  const [item] = await buildManifest(t);
  assertStamped(item.poster, 'media/_generated/a.jpg');
  assert.ok(existsSync(join(t.mediaDir, '_generated', 'a.jpg')));
  rmSync(t.root, { recursive: true });
});

test('handMadePosterWins', async () => {
  const t = setup(['a.mp4']);
  writeFileSync(join(t.mediaDir, 'a.jpg'), 'fake');
  const [item] = await buildManifest(t);
  assertStamped(item.poster, 'media/a.jpg');
  assert.ok(!existsSync(join(t.mediaDir, '_generated', 'a.jpg')));
  rmSync(t.root, { recursive: true });
});

test('emptyDirGivesEmptyArray', async () => {
  const t = setup([]);
  assert.deepEqual(await buildManifest(t), []);
  assert.equal(readFileSync(t.outFile, 'utf8').trim(), '[]');
  rmSync(t.root, { recursive: true });
});

test('idIsUrlSafeForSpacesAndCapitals', async () => {
  const t = setup(['My Clip 2.mp4']);
  const [item] = await buildManifest(t);
  assert.equal(item.id, 'my-clip-2');
  assert.equal(encodeURI(item.video), item.video);
  assert.equal(encodeURI(item.poster), item.poster);
  assert.ok(existsSync(join(t.root, item.video.split("?")[0])));
  rmSync(t.root, { recursive: true });
});

test('unicodeAndEmptySlugAndCollisionsAreDeterministic', async () => {
  const t = setup(['Café.mp4', 'cafe.mp4', '日本.mp4']);
  const items = await buildManifest(t);
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id) => /^[a-z0-9-]+$/.test(id)));
  assert.ok(ids.includes('cafe') && ids.includes('cafe-2') && ids.includes('clip'));
  for (const i of items) assert.equal(encodeURI(i.video), i.video);
  rmSync(t.root, { recursive: true });
});

test('webmIsOptional', async () => {
  const t = setup(['a.mp4', 'b.mp4']);
  copyFileSync(join(t.mediaDir, 'a.mp4'), join(t.mediaDir, 'a.webm'));
  const items = await buildManifest(t);
  assertStamped(items[0].webm, 'media/a.webm');
  assert.ok(!('webm' in items[1]));
  rmSync(t.root, { recursive: true });
});

test('missingFfmpegThrowsClearError', async () => {
  const t = setup(['a.mp4']);
  await assert.rejects(
    buildManifest({ ...t, ffmpegBin: '/nonexistent/ffmpeg', ffprobeBin: '/nonexistent/ffprobe' }),
    /ffmpeg|ffprobe/i,
  );
  rmSync(t.root, { recursive: true });
});

test('unreadableVideoThrowsNamingTheFile', async () => {
  const t = setup([]);
  writeFileSync(join(t.mediaDir, 'bad.mp4'), 'not a video');
  await assert.rejects(buildManifest(t), /bad\.mp4/);
  rmSync(t.root, { recursive: true });
});

test('hevcCompanionIsListedOnTheItem', async () => {
  const t = setup(['a.mp4', 'b.mp4']);
  copyFileSync(join(t.mediaDir, 'a.mp4'), join(t.mediaDir, 'a.hevc.mp4'));
  const items = await buildManifest(t);
  assert.deepEqual(items.map((i) => i.id), ['a', 'b']);
  assertStamped(items[0].hevc, 'media/a.hevc.mp4');
  assertStamped(items[0].video, 'media/a.mp4');
  assert.ok(!('hevc' in items[1]), 'a clip with only H.264 has no hevc field');
  rmSync(t.root, { recursive: true });
});

test('hevcFileIsNeverItsOwnItem', async () => {
  const t = setup(['a.mp4']);
  copyFileSync(join(t.mediaDir, 'a.mp4'), join(t.mediaDir, 'a.hevc.mp4'));
  // An orphan HEVC file (no H.264 partner) is ignored, not turned into a clip.
  copyFileSync(join(t.mediaDir, 'a.mp4'), join(t.mediaDir, 'orphan.HEVC.mp4'));
  const items = await buildManifest(t);
  assert.deepEqual(items.map((i) => i.id), ['a']);
  rmSync(t.root, { recursive: true });
});

test('hevcWithUnsafeNameIsCopiedNextToTheVideo', async () => {
  const t = setup(['My Clip.mp4']);
  copyFileSync(join(t.mediaDir, 'My Clip.mp4'), join(t.mediaDir, 'My Clip.hevc.mp4'));
  const [item] = await buildManifest(t);
  assertStamped(item.video, 'media/_generated/my-clip.mp4');
  assertStamped(item.hevc, 'media/_generated/my-clip.hevc.mp4');
  assert.equal(encodeURI(item.hevc), item.hevc);
  assert.ok(existsSync(join(t.root, item.hevc.split("?")[0])));
  assert.ok(existsSync(join(t.root, item.video.split("?")[0])));
  rmSync(t.root, { recursive: true });
});

test('stampChangesWhenTheFileContentChanges', async () => {
  const t = setup(['a.mp4']);
  const [first] = await buildManifest(t);
  appendFileSync(join(t.mediaDir, 'a.mp4'), Buffer.alloc(64)); // trailing bytes: still a readable clip, different content
  const [second] = await buildManifest(t);
  assert.notEqual(first.video, second.video);
  assert.equal(first.video.split('?')[0], second.video.split('?')[0]);
  rmSync(t.root, { recursive: true });
});
