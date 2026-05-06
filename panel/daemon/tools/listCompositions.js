export const JSX_CODE = `(function() {
  var items = app.project.items;
  var comps = [];
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    if (it instanceof CompItem) {
      var folder = it.parentFolder ? it.parentFolder.name : null;
      comps.push({
        id: it.id,
        name: it.name,
        width: it.width,
        height: it.height,
        frameRate: it.frameRate,
        duration: it.duration,
        numLayers: it.numLayers,
        bgColor: it.bgColor,
        folder: folder
      });
    }
  }
  return JSON.stringify({ ok: true, count: comps.length, compositions: comps });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'listCompositions',
    {
      description:
        'List all compositions in the project (not just active). Returns id, name, dims, fps, duration, layer count, parent folder. Use to navigate multi-comp projects.',
      inputSchema: {
        nameFilter: z.string().optional().describe('Filter by name (case-insensitive substring match)'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ nameFilter, aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'listCompositions', true, aeVersion);
        var parsed = JSON.parse(raw);
        var inner = parsed.ok && parsed.result ? JSON.parse(parsed.result) : parsed;
        if (inner.error) return { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: true };
        var out = inner.compositions;
        if (nameFilter) {
          var f = nameFilter.toLowerCase();
          out = out.filter((c) => c.name.toLowerCase().indexOf(f) !== -1);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ count: out.length, compositions: out }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
      }
    }
  );
}
