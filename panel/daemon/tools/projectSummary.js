/**
 * getProjectSummary tool — inlines ExtendScript to avoid host.jsx caching issues.
 */
export const JSX_CODE = `(function() {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  var selected = [];
  for (var i = 0; i < comp.selectedLayers.length; i++) {
    var l = comp.selectedLayers[i];
    var layerType = "Layer";
    if (l instanceof ShapeLayer) layerType = "ShapeLayer";
    else if (l instanceof TextLayer) layerType = "TextLayer";
    else if (l instanceof CameraLayer) layerType = "CameraLayer";
    else if (l instanceof LightLayer) layerType = "LightLayer";
    else if (l instanceof AVLayer) layerType = "AVLayer";
    selected.push({
      index: l.index, name: l.name, type: layerType,
      enabled: l.enabled, inPoint: l.inPoint, outPoint: l.outPoint
    });
  }
  var selectedIndices = [];
  for (var j = 0; j < selected.length; j++) selectedIndices.push(selected[j].index);
  return JSON.stringify({
    activeItem: {
      name: comp.name, width: comp.width, height: comp.height,
      frameRate: comp.frameRate, duration: comp.duration,
      numLayers: comp.numLayers, selectedLayerIndices: selectedIndices
    },
    selectedLayers: selected,
    projectPath: app.project.file ? app.project.file.fsName : null,
    numItems: app.project.numItems
  });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'getProjectSummary',
    {
      description:
        'Get a summary of the active AE project: active comp details, selected layers, project path, and item count. Call this before any non-trivial task to understand project state.',
      inputSchema: {
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open. Omit if only one AE is open.'),
      },
    },
    async ({ aeVersion } = {}) => {
      try {
        var result = await queue.enqueue(JSX_CODE, 'getProjectSummary', true, aeVersion);
        return { content: [{ type: 'text', text: result }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }],
          isError: true,
        };
      }
    }
  );
}
