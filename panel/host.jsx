// Gaffer host.jsx — ExtendScript helpers pre-loaded into After Effects.

function gafferGetProjectSummary() {
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
      index: l.index,
      name: l.name,
      type: layerType,
      enabled: l.enabled,
      inPoint: l.inPoint,
      outPoint: l.outPoint
    });
  }

  var selectedIndices = [];
  for (var j = 0; j < selected.length; j++) {
    selectedIndices.push(selected[j].index);
  }

  return JSON.stringify({
    activeItem: {
      name: comp.name,
      width: comp.width,
      height: comp.height,
      frameRate: comp.frameRate,
      duration: comp.duration,
      numLayers: comp.numLayers,
      selectedLayerIndices: selectedIndices
    },
    selectedLayers: selected,
    projectPath: app.project.file ? app.project.file.fsName : null,
    numItems: app.project.numItems
  });
}

function gafferGetEffectMatchNames() {
  var result = {};
  for (var i = 0; i < app.effects.length; i++) {
    var eff = app.effects[i];
    var cat = eff.category || "Uncategorized";
    if (!result[cat]) result[cat] = [];
    result[cat].push({
      displayName: eff.displayName,
      matchName: eff.matchName
    });
  }
  return JSON.stringify(result);
}
