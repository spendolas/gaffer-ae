// Exports the share image from its frame in Figma (through Grip) to site/og.jpg, the committed image.
//   node scripts/site/figma-export-og.mjs [nodeId]     (default: the frame below; the Grip plugin must be open in the file)
// The design lives in Figma. This only exports it: 1x, so the file is exactly 1200 x 630.
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectGrip } from './grip-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_FRAME = '659:4202'; // Plugin Dev > Gaffer page > "Share image 1200x630"
const frameId = process.argv.slice(2).find((a) => /^\d+:\d+$/.test(a)) ?? DEFAULT_FRAME;

async function main() {
  const call = await connectGrip();
  const out = join(root, 'site/og.jpg');
  const res = await call('export_node', { nodeId: frameId, format: 'JPG', path: out, constraint: { type: 'SCALE', value: 1 } });
  console.log(`exported ${frameId} to site/og.jpg (${res.width}x${res.height}, ${res.bytes} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
