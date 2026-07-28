export const JSX_CODE = `(function() {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  function markerAt(prop, i) {
    var v = prop.keyValue(i);
    var m = {
      time: prop.keyTime(i),
      comment: v.comment || "",
      duration: v.duration || 0
    };
    if (v.chapter) m.chapter = v.chapter;
    if (v.url) m.url = v.url;
    if (v.cuePointName) m.cuePointName = v.cuePointName;
    try { if (v.label) m.label = v.label; } catch (e) { /* pre-16 AE */ }
    try { if (v.protectedRegion) m.protectedRegion = true; } catch (e) { /* pre-14 AE */ }
    return m;
  }
  var out = { ok: true, comp: comp.name, compMarkers: [], layerMarkers: [] };
  try {
    var cm = comp.markerProperty;
    for (var i = 1; i <= cm.numKeys; i++) out.compMarkers.push(markerAt(cm, i));
  } catch (e) { /* no comp markers */ }
  for (var li = 1; li <= comp.numLayers; li++) {
    var layer = comp.layer(li);
    try {
      var lm = layer.marker;
      if (lm && lm.numKeys > 0) {
        var arr = [];
        for (var k = 1; k <= lm.numKeys; k++) arr.push(markerAt(lm, k));
        out.layerMarkers.push({ layerIndex: layer.index, layer: layer.name, markers: arr });
      }
    } catch (e) { /* layer without marker property */ }
  }
  return JSON.stringify(out);
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'listMarkers',
    {
      description:
        'All markers in the active composition: comp markers and per-layer markers with time, duration, comment, chapter/url/cue-point when present. Use for timing anchors, sync points, and beat maps.',
      inputSchema: {
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'listMarkers', true, aeVersion);
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
