function buildJSX(itemId, newPath) {
  var pathJSON = JSON.stringify(newPath);
  return `(function() {
  var item = app.project.itemByID(${itemId});
  if (!item) return JSON.stringify({ error: "No item with id ${itemId}" });
  if (!(item instanceof FootageItem)) return JSON.stringify({ error: "Item is not FootageItem (was: " + item.typeName + ")" });
  var f = new File(${pathJSON});
  if (!f.exists) return JSON.stringify({ error: "File not found: " + f.fsName });
  try {
    item.replace(f);
  } catch (e) {
    return JSON.stringify({ error: "replace failed: " + e.toString() });
  }
  var src = item.mainSource;
  return JSON.stringify({
    ok: true,
    name: item.name,
    newPath: (src && src.file) ? src.file.fsName : null,
    missing: !!(src && src.missingFootagePath)
  });
})()`;
}

export function register(server, queue, z) {
  server.registerTool(
    'relinkFootage',
    {
      description:
        'Repoint a missing/existing FootageItem to a new file path. Modifies project. Use after listFootage to identify missing items.',
      inputSchema: {
        itemId: z.number().describe('FootageItem id (from listFootage)'),
        newPath: z.string().describe('Absolute path to the replacement file'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ itemId, newPath, aeVersion }) => {
      try {
        var raw = await queue.enqueue(buildJSX(itemId, newPath), 'relinkFootage', false, aeVersion);
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
