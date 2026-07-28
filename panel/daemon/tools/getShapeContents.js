export const JSX_CODE = `(function() {
  var layerIndex = __LAYER_INDEX__;
  var includePoints = __INCLUDE_POINTS__;
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  if (layerIndex < 1 || layerIndex > comp.numLayers) {
    return JSON.stringify({ error: "layerIndex out of range (1-" + comp.numLayers + ")" });
  }
  var layer = comp.layer(layerIndex);
  function shapeValue(prop) {
    try {
      var s = prop.value;
      var out = { closed: s.closed, vertexCount: s.vertices.length };
      if (includePoints) {
        out.vertices = s.vertices;
        out.inTangents = s.inTangents;
        out.outTangents = s.outTangents;
      }
      return out;
    } catch (e) { return { error: "unreadable path" }; }
  }
  function leafValue(prop) {
    try {
      if (prop.propertyValueType === PropertyValueType.SHAPE) return shapeValue(prop);
      if (prop.propertyValueType === PropertyValueType.NO_VALUE) return undefined;
      if (prop.propertyValueType === PropertyValueType.CUSTOM_VALUE) return "(custom)";
      return prop.value;
    } catch (e) { return "(unreadable)"; }
  }
  function walk(group) {
    var items = [];
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (p.numProperties !== undefined && p.numProperties !== null && p.propertyType !== PropertyType.PROPERTY) {
        var node = { name: p.name, matchName: p.matchName };
        try { if (p.enabled !== undefined) node.enabled = p.enabled; } catch (e0) {}
        node.contents = walk(p);
        items.push(node);
        continue;
      }
      var entry = { name: p.name, matchName: p.matchName };
      var v = leafValue(p);
      if (v !== undefined) entry.value = v;
      try { if (p.numKeys > 0) entry.keys = p.numKeys; } catch (e1) {}
      try { if (p.expression) entry.expression = p.expression; } catch (e2) {}
      items.push(entry);
    }
    return items;
  }
  var out = { ok: true, comp: comp.name, layerIndex: layer.index, layer: layer.name };
  var root = null;
  try { root = layer.property("ADBE Root Vectors Group"); } catch (eR) {}
  if (root) out.shapeContents = walk(root);
  var masks = null;
  try { masks = layer.property("ADBE Mask Parade"); } catch (eM) {}
  if (masks && masks.numProperties > 0) {
    out.masks = [];
    for (var m = 1; m <= masks.numProperties; m++) {
      var mask = masks.property(m);
      var mEntry = { index: m, name: mask.name, inverted: mask.inverted, maskMode: mask.maskMode };
      try { mEntry.opacity = mask.property("ADBE Mask Opacity").value; } catch (e3) {}
      try { mEntry.feather = mask.property("ADBE Mask Feather").value; } catch (e4) {}
      try { mEntry.expansion = mask.property("ADBE Mask Offset").value; } catch (e5) {}
      try { mEntry.path = shapeValue(mask.property("ADBE Mask Shape")); } catch (e6) {}
      out.masks.push(mEntry);
    }
  }
  if (!root && (!masks || masks.numProperties === 0)) {
    out.note = "layer has no shape contents and no masks";
  }
  return JSON.stringify(out);
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'getShapeContents',
    {
      description:
        "Structured dump of a layer's vector geometry: the full shape-layer contents tree (groups, paths, fills, strokes, path operators — with matchNames, values, keyframe counts) and all masks (mode, inverted, opacity, feather, path). Pass includePoints for raw vertex/tangent data. Saves blind probing of the hairiest scripting surface in AE.",
      inputSchema: {
        layerIndex: z.number().describe('1-based layer index in the active comp'),
        includePoints: z.boolean().optional().describe('Include raw vertices/tangents for every path (default false — counts only)'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ layerIndex, includePoints, aeVersion } = {}) => {
      try {
        var code = JSX_CODE
          .replace('__LAYER_INDEX__', String(Math.floor(layerIndex)))
          .replace('__INCLUDE_POINTS__', includePoints ? 'true' : 'false');
        var raw = await queue.enqueue(code, 'getShapeContents', true, aeVersion);
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
