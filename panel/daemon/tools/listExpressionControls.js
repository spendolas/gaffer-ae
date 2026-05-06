export const JSX_CODE = `(function() {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  var CONTROL_PREFIXES = [
    "ADBE Slider Control",
    "ADBE Angle Control",
    "ADBE Color Control",
    "ADBE Point Control",
    "ADBE Point3D Control",
    "ADBE Checkbox Control",
    "ADBE Layer Control",
    "ADBE Dropdown Control"
  ];
  function isControl(matchName) {
    for (var i = 0; i < CONTROL_PREFIXES.length; i++) {
      if (matchName.indexOf(CONTROL_PREFIXES[i]) === 0) return true;
    }
    return false;
  }
  var out = [];
  for (var i = 1; i <= comp.numLayers; i++) {
    var l = comp.layer(i);
    var fx = l.property("ADBE Effect Parade");
    if (!fx) continue;
    for (var j = 1; j <= fx.numProperties; j++) {
      var eff = fx.property(j);
      if (!isControl(eff.matchName)) continue;
      var paramVal = null;
      try {
        var inner = eff.property(1);
        if (inner) paramVal = inner.value;
      } catch (e) {}
      out.push({
        layerIndex: i,
        layer: l.name,
        effectIndex: j,
        effectName: eff.name,
        matchName: eff.matchName,
        value: paramVal,
        bindRef: 'thisComp.layer("' + l.name + '").effect("' + eff.name + '")("' + (eff.property(1) ? eff.property(1).matchName : '') + '")'
      });
    }
  }
  return JSON.stringify({ ok: true, comp: comp.name, count: out.length, controls: out });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'listExpressionControls',
    {
      description:
        'List Expression Control effects (Slider, Angle, Color, Point, Checkbox, Layer, Dropdown) on layers in active comp. Returns ready-to-use bindRef strings for expressions to reference these controls.',
      inputSchema: {
        layerIndex: z.number().optional().describe('Filter to a single layer (1-indexed)'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ layerIndex, aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'listExpressionControls', true, aeVersion);
        var parsed = JSON.parse(raw);
        var inner = parsed.ok && parsed.result ? JSON.parse(parsed.result) : parsed;
        if (inner.error) return { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: true };
        var ctrls = layerIndex ? inner.controls.filter((c) => c.layerIndex === layerIndex) : inner.controls;
        return { content: [{ type: 'text', text: JSON.stringify({ comp: inner.comp, count: ctrls.length, controls: ctrls }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
      }
    }
  );
}
