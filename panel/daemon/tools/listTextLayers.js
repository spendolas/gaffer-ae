export const JSX_CODE = `(function() {
  var scope = "__SCOPE__";
  function dumpComp(comp) {
    var layers = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      var layer = comp.layer(i);
      if (!(layer instanceof TextLayer)) continue;
      var entry = { layerIndex: layer.index, layer: layer.name, enabled: layer.enabled };
      try {
        var doc = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
        entry.text = doc.text;
        try { entry.font = doc.font; } catch (e1) {}
        try { entry.fontSize = doc.fontSize; } catch (e2) {}
        try { entry.tracking = doc.tracking; } catch (e3) {}
        try { if (doc.applyFill) entry.fillColor = doc.fillColor; } catch (e4) {}
        try { if (doc.applyStroke) { entry.strokeColor = doc.strokeColor; entry.strokeWidth = doc.strokeWidth; } } catch (e5) {}
        try { entry.justification = doc.justification; } catch (e6) {}
        try {
          entry.boxText = doc.boxText;
          if (doc.boxText) entry.boxTextSize = doc.boxTextSize;
        } catch (e7) {}
        try { if (!doc.autoLeading) entry.leading = doc.leading; } catch (e8) {}
      } catch (e) {
        entry.error = "could not read text document";
      }
      layers.push(entry);
    }
    return layers;
  }
  if (scope === "all") {
    var comps = [];
    for (var j = 1; j <= app.project.numItems; j++) {
      var item = app.project.item(j);
      if (!(item instanceof CompItem)) continue;
      var found = dumpComp(item);
      if (found.length) comps.push({ comp: item.name, compId: item.id, textLayers: found });
    }
    return JSON.stringify({ ok: true, scope: "all", comps: comps });
  }
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  return JSON.stringify({ ok: true, scope: "active", comp: comp.name, textLayers: dumpComp(comp) });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'listTextLayers',
    {
      description:
        'Dump every text layer with its content and type styling: text, font (postScriptName), size, tracking, fill/stroke, justification, box-text bounds. Scope the active comp or the whole project. Use for copy audits, find-and-replace planning, and localization passes.',
      inputSchema: {
        scope: z.enum(['active', 'all']).optional().describe("'active' (default) = active comp only; 'all' = every comp in the project"),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ scope, aeVersion } = {}) => {
      try {
        var code = JSX_CODE.replace('__SCOPE__', scope === 'all' ? 'all' : 'active');
        var raw = await queue.enqueue(code, 'listTextLayers', true, aeVersion);
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
