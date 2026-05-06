/**
 * captureLayer — solo a layer, render frame, restore solo state.
 * Wrapped in undo group so the solo flag flip is undoable.
 */
import { tmpdir } from 'node:os';

var MAX_CAPTURES = 10;
var CAPTURE_DIR = tmpdir();
var CAPTURE_PREFIX = 'gaffer-layer-';

function buildJSX(outputPath, layerIndex, time) {
  var t = (time === null || time === undefined) ? 'comp.time' : Number(time);
  return `(function() {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) return JSON.stringify({ error: "No active composition" });
  if (${layerIndex} < 1 || ${layerIndex} > comp.numLayers) return JSON.stringify({ error: "layerIndex out of range" });

  // Snapshot solo state of every layer, then solo target only
  var prev = [];
  for (var i = 1; i <= comp.numLayers; i++) {
    prev.push(comp.layer(i).solo);
    comp.layer(i).solo = false;
  }
  comp.layer(${layerIndex}).solo = true;

  var t = ${t};
  if (t < 0) t = 0;
  if (t > comp.duration - comp.frameDuration) t = comp.duration - comp.frameDuration;

  var f = new File("${outputPath}");
  var err = null;
  try {
    comp.saveFrameToPng(t, f).wait();
  } catch (e) {
    err = e.toString();
  }

  // Restore solo state
  for (var j = 1; j <= comp.numLayers; j++) {
    comp.layer(j).solo = prev[j - 1];
  }

  if (err) return JSON.stringify({ error: "saveFrameToPng failed: " + err });
  if (!f.exists) return JSON.stringify({ error: "saveFrameToPng failed — file not created" });
  return JSON.stringify({
    ok: true,
    path: f.fsName,
    layer: comp.layer(${layerIndex}).name,
    layerIndex: ${layerIndex},
    width: comp.width,
    height: comp.height,
    time: t
  });
})()`;
}

export function register(server, queue, z) {
  server.registerTool(
    'captureLayer',
    {
      description:
        'Render a single layer in isolation (temporarily soloed) at time T to PNG. Solo state is fully restored. Useful to inspect what one layer looks like.',
      inputSchema: {
        layerIndex: z.number().describe('1-indexed layer in active comp'),
        time: z.number().optional().describe('Time in seconds. Omit for current CTI.'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ layerIndex, time, aeVersion }) => {
      try {
        var outputPath = `${CAPTURE_DIR}/${CAPTURE_PREFIX}${Date.now()}.png`;
        var raw = await queue.enqueue(buildJSX(outputPath, layerIndex, time ?? null), 'captureLayer', true, aeVersion);
        cleanup().catch(() => {});
        var parsed = JSON.parse(raw);
        var inner = parsed.ok && parsed.result ? JSON.parse(parsed.result) : parsed;
        if (inner.error) return { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(inner, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
      }
    }
  );
}

async function cleanup() {
  var { readdir, unlink } = await import('node:fs/promises');
  var files = await readdir(CAPTURE_DIR);
  var caps = files.filter((f) => f.startsWith(CAPTURE_PREFIX) && f.endsWith('.png')).sort();
  while (caps.length > MAX_CAPTURES) {
    var oldest = caps.shift();
    await unlink(`${CAPTURE_DIR}/${oldest}`).catch(() => {});
  }
}
