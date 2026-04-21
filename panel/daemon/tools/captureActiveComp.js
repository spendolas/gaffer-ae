/**
 * captureActiveComp tool — renders current frame of active comp to PNG.
 * Uses comp.saveFrameToPng() (AE 2023+ / v23.0+).
 * Saves to /tmp/gaffer-capture-<timestamp>.png, cleans up old captures.
 */

var MAX_CAPTURES = 10;
var CAPTURE_DIR = '/tmp';
var CAPTURE_PREFIX = 'gaffer-capture-';

function buildJSX(outputPath) {
  return `(function() {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  var f = new File("${outputPath}");
  comp.saveFrameToPng(comp.time, f);
  if (f.exists) {
    return JSON.stringify({ ok: true, path: f.fsName, width: comp.width, height: comp.height, time: comp.time });
  } else {
    return JSON.stringify({ error: "saveFrameToPng failed — file not created" });
  }
})()`;
}

export function register(server, queue, z) {
  server.registerTool(
    'captureActiveComp',
    {
      description:
        'Capture the current frame of the active composition as a PNG screenshot. Returns the file path. Useful for visual inspection of what the comp looks like right now.',
      inputSchema: {},
    },
    async () => {
      try {
        var timestamp = Date.now();
        var outputPath = `${CAPTURE_DIR}/${CAPTURE_PREFIX}${timestamp}.png`;
        var jsx = buildJSX(outputPath);
        var raw = await queue.enqueue(jsx, 'captureActiveComp');

        // Clean up old captures (keep last MAX_CAPTURES)
        cleanup().catch(() => {});

        var parsed = JSON.parse(raw);
        if (parsed.ok === true && parsed.result) {
          // Safety wrapper wraps in {ok, result} where result is the inner JSON string
          var inner = JSON.parse(parsed.result);
          if (inner.error) {
            return { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: true };
          }
          return { content: [{ type: 'text', text: JSON.stringify(inner, null, 2) }] };
        } else if (parsed.ok === false) {
          return { content: [{ type: 'text', text: raw }], isError: true };
        }
        // Direct result (no wrapper)
        if (parsed.error) {
          return { content: [{ type: 'text', text: JSON.stringify(parsed) }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }],
          isError: true,
        };
      }
    }
  );
}

async function cleanup() {
  var { readdir, unlink } = await import('node:fs/promises');
  var files = await readdir(CAPTURE_DIR);
  var captures = files
    .filter((f) => f.startsWith(CAPTURE_PREFIX) && f.endsWith('.png'))
    .sort();
  while (captures.length > MAX_CAPTURES) {
    var oldest = captures.shift();
    await unlink(`${CAPTURE_DIR}/${oldest}`).catch(() => {});
  }
}
