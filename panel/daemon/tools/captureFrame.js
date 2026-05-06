/**
 * captureFrame — render a single frame at time T (or current) to PNG.
 * Optional compId targets a specific comp (else active).
 */
import { tmpdir } from 'node:os';

var MAX_CAPTURES = 10;
var CAPTURE_DIR = tmpdir();
var CAPTURE_PREFIX = 'gaffer-frame-';

function buildJSX(outputPath, time, compId) {
  var compResolve = (compId !== null && compId !== undefined)
    ? `var comp = app.project.itemByID(${compId}); if (!(comp instanceof CompItem)) return JSON.stringify({ error: "No comp with id ${compId}" });`
    : `var comp = app.project.activeItem; if (!(comp instanceof CompItem)) return JSON.stringify({ error: "No active composition" });`;
  var t = (time === null || time === undefined) ? 'comp.time' : Number(time);
  return `(function() {
  ${compResolve}
  var t = ${t};
  if (t < 0) t = 0;
  if (t > comp.duration - comp.frameDuration) t = comp.duration - comp.frameDuration;
  var f = new File("${outputPath}");
  try {
    comp.saveFrameToPng(t, f).wait();
  } catch (e) {
    return JSON.stringify({ error: "saveFrameToPng failed: " + e.toString() });
  }
  if (!f.exists) return JSON.stringify({ error: "saveFrameToPng failed — file not created" });
  return JSON.stringify({ ok: true, path: f.fsName, comp: comp.name, width: comp.width, height: comp.height, time: t });
})()`;
}

export function register(server, queue, z) {
  server.registerTool(
    'captureFrame',
    {
      description:
        'Render single frame of a comp at time T (seconds) to PNG. Defaults to active comp + current time. Use compId from listCompositions to target non-active comp.',
      inputSchema: {
        time: z.number().optional().describe('Time in seconds. Omit for current CTI.'),
        compId: z.number().optional().describe('Target comp id (from listCompositions). Omit for active comp.'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ time, compId, aeVersion } = {}) => {
      try {
        var outputPath = `${CAPTURE_DIR}/${CAPTURE_PREFIX}${Date.now()}.png`;
        var raw = await queue.enqueue(buildJSX(outputPath, time ?? null, compId ?? null), 'captureFrame', true, aeVersion);
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
