export const JSX_CODE = `(function() {
  var layerIndex = __LAYER_INDEX__;
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  if (layerIndex < 1 || layerIndex > comp.numLayers) {
    return JSON.stringify({ error: "layerIndex out of range (1-" + comp.numLayers + ")" });
  }
  var layer = comp.layer(layerIndex);
  function leafValue(prop) {
    try {
      if (prop.propertyValueType === PropertyValueType.NO_VALUE) return undefined;
      if (prop.propertyValueType === PropertyValueType.CUSTOM_VALUE) return "(custom)";
      return prop.value;
    } catch (e) { return "(unreadable)"; }
  }
  function walkProps(group) {
    var props = [];
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (p.numProperties !== undefined && p.numProperties !== null && p.propertyType !== PropertyType.PROPERTY) {
        var kids = walkProps(p);
        if (kids.length) props.push({ name: p.name, matchName: p.matchName, group: true, props: kids });
        continue;
      }
      var entry = { name: p.name, matchName: p.matchName };
      var v = leafValue(p);
      if (v !== undefined) entry.value = v;
      try { if (p.numKeys > 0) entry.keys = p.numKeys; } catch (e1) {}
      try { if (p.expression) { entry.expression = p.expression; entry.expressionEnabled = p.expressionEnabled; } } catch (e2) {}
      props.push(entry);
    }
    return props;
  }
  var out = { ok: true, comp: comp.name, layerIndex: layer.index, layer: layer.name, effects: [] };
  var parade = layer.property("ADBE Effect Parade");
  if (!parade) return JSON.stringify(out);
  for (var e = 1; e <= parade.numProperties; e++) {
    var fx = parade.property(e);
    out.effects.push({
      index: e,
      name: fx.name,
      matchName: fx.matchName,
      enabled: fx.enabled,
      props: walkProps(fx)
    });
  }
  return JSON.stringify(out);
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'getLayerEffects',
    {
      description:
        "One layer's full effect stack with current values: every effect (name, matchName, enabled) and its parameters (values, keyframe counts, expressions). Complements findLayers (which searches by effect) with the complete per-layer picture.",
      inputSchema: {
        layerIndex: z.number().describe('1-based layer index in the active comp'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ layerIndex, aeVersion } = {}) => {
      try {
        var code = JSX_CODE.replace('__LAYER_INDEX__', String(Math.floor(layerIndex)));
        var raw = await queue.enqueue(code, 'getLayerEffects', true, aeVersion);
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
