export const JSX_CODE = `(function() {
  var items = app.project.items;
  var out = [];
  var missing = 0;
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    if (!(it instanceof FootageItem)) continue;
    var src = it.mainSource;
    var path = null, missingPath = null, kind = "Solid";
    if (src instanceof FileSource) {
      path = (src.file && src.file.fsName) ? src.file.fsName : null;
      missingPath = src.missingFootagePath || null;
      kind = "File";
    } else if (src instanceof PlaceholderSource) {
      kind = "Placeholder";
    } else if (src instanceof SolidSource) {
      kind = "Solid";
    }
    if (missingPath) missing++;
    out.push({
      id: it.id,
      name: it.name,
      kind: kind,
      path: path,
      missing: !!missingPath,
      missingPath: missingPath,
      width: it.width,
      height: it.height,
      duration: it.duration,
      hasVideo: it.hasVideo,
      hasAudio: it.hasAudio,
      usedIn: it.usedIn ? it.usedIn.length : 0
    });
  }
  return JSON.stringify({ ok: true, count: out.length, missingCount: missing, items: out });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'listFootage',
    {
      description:
        'List all FootageItems in project: file path, missing flag, dims, duration, usedIn count. Use to spot missing media or audit assets.',
      inputSchema: {
        onlyMissing: z.boolean().optional().describe('Return only items with missing media'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ onlyMissing, aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'listFootage', true, aeVersion);
        var parsed = JSON.parse(raw);
        var inner = parsed.ok && parsed.result ? JSON.parse(parsed.result) : parsed;
        if (inner.error) return { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: true };
        var items = onlyMissing ? inner.items.filter((x) => x.missing) : inner.items;
        return { content: [{ type: 'text', text: JSON.stringify({ count: items.length, missingCount: inner.missingCount, items }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
      }
    }
  );
}
