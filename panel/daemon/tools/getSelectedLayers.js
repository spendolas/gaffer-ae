export const JSX_CODE = `(function() {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  function typeOf(l) {
    if (l instanceof TextLayer) return "TextLayer";
    if (l instanceof ShapeLayer) return "ShapeLayer";
    if (l instanceof CameraLayer) return "CameraLayer";
    if (l instanceof LightLayer) return "LightLayer";
    if (l instanceof AVLayer) {
      if (l.source instanceof CompItem) return "PrecompLayer";
      return "AVLayer";
    }
    return "Layer";
  }
  function xform(l) {
    var t = l.property("ADBE Transform Group");
    function v(name) {
      var p = t.property(name);
      return { value: p.value, hasKeys: p.numKeys > 0, expression: p.expression || null };
    }
    return {
      anchor: v("ADBE Anchor Point"),
      position: v("ADBE Position"),
      scale: v("ADBE Scale"),
      rotation: v("ADBE Rotate Z"),
      opacity: v("ADBE Opacity")
    };
  }
  var out = [];
  for (var i = 0; i < comp.selectedLayers.length; i++) {
    var l = comp.selectedLayers[i];
    var sourceName = null, sourceId = null;
    if (l.source) { sourceName = l.source.name; sourceId = l.source.id; }
    out.push({
      index: l.index,
      name: l.name,
      type: typeOf(l),
      enabled: l.enabled,
      solo: l.solo,
      shy: l.shy,
      locked: l.locked,
      threeD: l.threeDLayer,
      inPoint: l.inPoint,
      outPoint: l.outPoint,
      startTime: l.startTime,
      stretch: l.stretch,
      parentIndex: l.parent ? l.parent.index : null,
      sourceName: sourceName,
      sourceId: sourceId,
      transform: xform(l)
    });
  }
  return JSON.stringify({ ok: true, comp: comp.name, count: out.length, layers: out });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'getSelectedLayers',
    {
      description:
        'Get detailed snapshot of selected layers in active comp: type, transform values + keyframe presence + expressions, parent, source, in/out, 3D, lock/solo/shy. Use before editing selected layers.',
      inputSchema: {
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'getSelectedLayers', true, aeVersion);
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
