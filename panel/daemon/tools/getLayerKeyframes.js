function buildJSX(layerIndex, propPath) {
  var pathJSON = JSON.stringify(propPath);
  return `(function() {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  if (${layerIndex} < 1 || ${layerIndex} > comp.numLayers) {
    return JSON.stringify({ error: "layerIndex out of range" });
  }
  var l = comp.layer(${layerIndex});
  var path = ${pathJSON};
  var prop = l;
  for (var i = 0; i < path.length; i++) {
    prop = prop.property(path[i]);
    if (!prop) return JSON.stringify({ error: "Property not found at segment: " + path[i] });
  }
  if (prop.numKeys === undefined) {
    return JSON.stringify({ error: "Resolved object is not a Property" });
  }
  // KeyframeInterpolationType: LINEAR=6612, BEZIER=6613, HOLD=6614
  var interpMap = { 6612: "LINEAR", 6613: "BEZIER", 6614: "HOLD" };
  var keys = [];
  for (var k = 1; k <= prop.numKeys; k++) {
    var entry = {
      index: k,
      time: prop.keyTime(k),
      value: prop.keyValue(k),
      inInterp: interpMap[prop.keyInInterpolationType(k)] || prop.keyInInterpolationType(k),
      outInterp: interpMap[prop.keyOutInterpolationType(k)] || prop.keyOutInterpolationType(k)
    };
    try {
      var ie = prop.keyInTemporalEase(k);
      var oe = prop.keyOutTemporalEase(k);
      entry.inEase = [];
      entry.outEase = [];
      for (var e = 0; e < ie.length; e++) entry.inEase.push({ speed: ie[e].speed, influence: ie[e].influence });
      for (var f = 0; f < oe.length; f++) entry.outEase.push({ speed: oe[f].speed, influence: oe[f].influence });
    } catch (e) {}
    keys.push(entry);
  }
  return JSON.stringify({
    ok: true,
    layer: l.name,
    propName: prop.name,
    matchName: prop.matchName,
    numKeys: prop.numKeys,
    expression: prop.expression || null,
    keys: keys
  });
})()`;
}

export function register(server, queue, z) {
  server.registerTool(
    'getLayerKeyframes',
    {
      description:
        'Get keyframes for a single property on a layer in the active comp. propPath is an array of property names/match-names walked from the layer (e.g. ["ADBE Transform Group","ADBE Position"]). Returns time, value, in/out interp, ease.',
      inputSchema: {
        layerIndex: z.number().describe('1-indexed layer in active comp'),
        propPath: z.array(z.string()).describe('Property path from layer, e.g. ["ADBE Transform Group","ADBE Position"]'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ layerIndex, propPath, aeVersion }) => {
      try {
        var raw = await queue.enqueue(buildJSX(layerIndex, propPath), 'getLayerKeyframes', true, aeVersion);
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
