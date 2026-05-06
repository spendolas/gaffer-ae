function buildJSX(itemId) {
  return `(function() {
  var target = app.project.itemByID(${itemId});
  if (!target) return JSON.stringify({ error: "No item with id " + ${itemId} });
  var hits = [];
  var items = app.project.items;
  for (var k = 1; k <= items.length; k++) {
    var c = items[k];
    if (!(c instanceof CompItem)) continue;
    for (var i = 1; i <= c.numLayers; i++) {
      var l = c.layer(i);
      if (l.source && l.source.id === ${itemId}) {
        hits.push({ comp: c.name, compId: c.id, layerIndex: l.index, layerName: l.name });
      }
    }
  }
  return JSON.stringify({
    ok: true,
    itemName: target.name,
    itemKind: (target instanceof CompItem) ? "Comp" : (target instanceof FootageItem ? "Footage" : "Other"),
    count: hits.length,
    usages: hits
  });
})()`;
}

export function register(server, queue, z) {
  server.registerTool(
    'whereUsed',
    {
      description:
        'Find every comp + layer that uses a given footage or precomp item (by id from listFootage/listCompositions). Returns all usages.',
      inputSchema: {
        itemId: z.number().describe('Project item id (from listFootage or listCompositions)'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ itemId, aeVersion }) => {
      try {
        var raw = await queue.enqueue(buildJSX(itemId), 'whereUsed', true, aeVersion);
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
