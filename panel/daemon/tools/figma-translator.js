/**
 * figma-translator.js — Deterministic Figma→AE ExtendScript generator.
 * Pure function: translateToJSX(layers, artboard) → ExtendScript string.
 * No MCP, no queue, no side effects.
 */

// ── Blend mode mapping ──

var BLEND_MODES = {
  NORMAL: 'BlendingMode.NORMAL',
  PASS_THROUGH: 'BlendingMode.NORMAL',
  DARKEN: 'BlendingMode.DARKEN',
  MULTIPLY: 'BlendingMode.MULTIPLY',
  LINEAR_BURN: 'BlendingMode.LINEAR_BURN',
  COLOR_BURN: 'BlendingMode.COLOR_BURN',
  LIGHTEN: 'BlendingMode.LIGHTEN',
  SCREEN: 'BlendingMode.SCREEN',
  LINEAR_DODGE: 'BlendingMode.LINEAR_DODGE',
  COLOR_DODGE: 'BlendingMode.COLOR_DODGE',
  OVERLAY: 'BlendingMode.OVERLAY',
  SOFT_LIGHT: 'BlendingMode.SOFT_LIGHT',
  HARD_LIGHT: 'BlendingMode.HARD_LIGHT',
  DIFFERENCE: 'BlendingMode.DIFFERENCE',
  EXCLUSION: 'BlendingMode.EXCLUSION',
  HUE: 'BlendingMode.HUE',
  SATURATION: 'BlendingMode.SATURATION',
  COLOR: 'BlendingMode.COLOR',
  LUMINOSITY: 'BlendingMode.LUMINOSITY',
  ADD: 'BlendingMode.ADD',
  SUBTRACT: 'BlendingMode.SUBTRACT',
  DISSOLVE: 'BlendingMode.DISSOLVE',
  VIVID_LIGHT: 'BlendingMode.VIVID_LIGHT',
  PIN_LIGHT: 'BlendingMode.PIN_LIGHT',
  HARD_MIX: 'BlendingMode.HARD_MIX',
  DIVIDE: 'BlendingMode.DIVIDE',
  DARKER_COLOR: 'BlendingMode.DARKER_COLOR',
  LIGHTER_COLOR: 'BlendingMode.LIGHTER_COLOR',
};

var STROKE_CAP = { BUTT: 1, ROUND: 2, SQUARE: 3 };
var STROKE_JOIN = { MITER: 1, ROUND: 2, BEVEL: 3 };
var JUSTIFICATION = { LEFT: 'ParagraphJustification.LEFT_JUSTIFY', CENTER: 'ParagraphJustification.CENTER_JUSTIFY', RIGHT: 'ParagraphJustification.RIGHT_JUSTIFY' };

// ── Squircle path generation ──

function generateSquirclePath(w, h, radius, smoothing) {
  // Generate an 8-vertex bezier approximation of a squircle.
  // radius = corner radius, smoothing = 0-1 (0=circular arc, 1=full superellipse)
  var r = Math.min(radius, w / 2, h / 2);
  var hw = w / 2;
  var hh = h / 2;

  // Tangent length multiplier: circular arc uses ~0.5523, squircle extends further
  var k = 0.5523 + smoothing * 0.15; // smoothing extends the tangent handles
  var tk = r * k;

  // 8 vertices starting from top-right going clockwise
  var vertices = [
    [hw - r, -hh],       // top edge, before TR corner
    [hw, -hh + r],       // right edge, after TR corner
    [hw, hh - r],        // right edge, before BR corner
    [hw - r, hh],        // bottom edge, after BR corner
    [-hw + r, hh],       // bottom edge, before BL corner
    [-hw, hh - r],       // left edge, after BL corner
    [-hw, -hh + r],      // left edge, before TL corner
    [-hw + r, -hh],      // top edge, after TL corner
  ];

  var inTangents = [
    [-tk, 0],
    [0, -tk],
    [0, tk],
    [tk, 0],
    [tk, 0],
    [0, tk],
    [0, -tk],
    [-tk, 0],
  ];

  var outTangents = [
    [tk, 0],
    [0, tk],
    [0, -tk],
    [-tk, 0],
    [-tk, 0],
    [0, -tk],
    [0, tk],
    [tk, 0],
  ];

  return { vertices, inTangents, outTangents, closed: true };
}

// ── Per-corner radius path ──

function generateRoundedRectPath(w, h, radii) {
  // radii = [tl, tr, br, bl]
  var hw = w / 2;
  var hh = h / 2;
  var k = 0.5523;
  var tl = Math.min(radii[0], hw, hh);
  var tr = Math.min(radii[1], hw, hh);
  var br = Math.min(radii[2], hw, hh);
  var bl = Math.min(radii[3], hw, hh);

  var vertices = [
    [hw - tr, -hh], [hw, -hh + tr],
    [hw, hh - br], [hw - br, hh],
    [-hw + bl, hh], [-hw, hh - bl],
    [-hw, -hh + tl], [-hw + tl, -hh],
  ];
  var inT = [
    [-tr * k, 0], [0, -tr * k],
    [0, br * k], [br * k, 0],
    [bl * k, 0], [0, bl * k],
    [0, -tl * k], [-tl * k, 0],
  ];
  var outT = [
    [tr * k, 0], [0, tr * k],
    [0, -br * k], [-br * k, 0],
    [-bl * k, 0], [0, -bl * k],
    [0, tl * k], [tl * k, 0],
  ];

  return { vertices, inTangents: inT, outTangents: outT, closed: true };
}

// ── ExtendScript generators ──

function jsxEsc(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function jsxColor(c) {
  return '[' + (c.r || 0) + ',' + (c.g || 0) + ',' + (c.b || 0) + ']';
}

function jsxColor4(c) {
  return '[' + (c.r || 0) + ',' + (c.g || 0) + ',' + (c.b || 0) + ',' + (c.a !== undefined ? c.a : 1) + ']';
}

function jsxArr(arr) {
  return '[' + arr.map(function (v) {
    return Array.isArray(v) ? '[' + v.join(',') + ']' : v;
  }).join(',') + ']';
}

function generateShapePath(pathData) {
  var lines = [];
  lines.push('var s = new Shape();');
  lines.push('s.vertices = ' + jsxArr(pathData.vertices) + ';');
  lines.push('s.inTangents = ' + jsxArr(pathData.inTangents) + ';');
  lines.push('s.outTangents = ' + jsxArr(pathData.outTangents) + ';');
  lines.push('s.closed = ' + (pathData.closed !== false ? 'true' : 'false') + ';');
  return lines.join('\n');
}

function generateFills(layer, groupVar) {
  var lines = [];
  if (!layer.fills || !layer.fills.length) return lines;

  for (var i = 0; i < layer.fills.length; i++) {
    var fill = layer.fills[i];
    if (fill.type === 'SOLID' && fill.color) {
      lines.push('var fill = ' + groupVar + '.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");');
      lines.push('fill.property("ADBE Vector Fill Color").setValue(' + jsxColor(fill.color) + ');');
      if (fill.opacity !== undefined) {
        lines.push('fill.property("ADBE Vector Fill Opacity").setValue(' + (fill.opacity * 100) + ');');
      }
    } else if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL') {
      // Gradient limitation: can't set gradient colors via ExtendScript
      // Fall back to first stop color as solid
      if (fill.stops && fill.stops.length > 0) {
        lines.push('// NOTE: Gradient fill — ExtendScript cannot set gradient colors. Using first stop as solid.');
        lines.push('var fill = ' + groupVar + '.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");');
        lines.push('fill.property("ADBE Vector Fill Color").setValue(' + jsxColor(fill.stops[0].color) + ');');
        if (fill.stops[0].opacity !== undefined) {
          lines.push('fill.property("ADBE Vector Fill Opacity").setValue(' + (fill.stops[0].opacity * 100) + ');');
        }
      }
    }
  }
  return lines;
}

function generateStrokes(layer, groupVar) {
  var lines = [];
  if (!layer.strokes || !layer.strokes.length) return lines;

  for (var i = 0; i < layer.strokes.length; i++) {
    var stroke = layer.strokes[i];
    lines.push('var stroke = ' + groupVar + '.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Stroke");');
    if (stroke.color) {
      lines.push('stroke.property("ADBE Vector Stroke Color").setValue(' + jsxColor(stroke.color) + ');');
    }
    lines.push('stroke.property("ADBE Vector Stroke Width").setValue(' + (stroke.width || 1) + ');');
    if (stroke.opacity !== undefined) {
      lines.push('stroke.property("ADBE Vector Stroke Opacity").setValue(' + (stroke.opacity * 100) + ');');
    }
    if (stroke.cap) {
      lines.push('stroke.property("ADBE Vector Stroke Line Cap").setValue(' + (STROKE_CAP[stroke.cap] || 1) + ');');
    }
    if (stroke.join) {
      lines.push('stroke.property("ADBE Vector Stroke Line Join").setValue(' + (STROKE_JOIN[stroke.join] || 1) + ');');
    }
    if (stroke.dashes && stroke.dashes.length > 0) {
      for (var d = 0; d < stroke.dashes.length && d < 6; d++) {
        var propName = d % 2 === 0 ? 'ADBE Vector Stroke Dash ' + (Math.floor(d / 2) + 1) : 'ADBE Vector Stroke Gap ' + (Math.floor(d / 2) + 1);
        lines.push('stroke.property("' + propName + '").setValue(' + stroke.dashes[d] + ');');
      }
    }
  }
  return lines;
}

function generateEffects(layer, layerVar) {
  var lines = [];
  if (!layer.effects || !layer.effects.length) return lines;

  for (var i = 0; i < layer.effects.length; i++) {
    var fx = layer.effects[i];
    if (fx.type === 'DROP_SHADOW' || fx.type === 'INNER_SHADOW') {
      lines.push('var shadow = ' + layerVar + '.property("Effects").addProperty("ADBE Drop Shadow");');
      if (fx.color) {
        lines.push('shadow.property("ADBE Drop Shadow-0002").setValue(' + jsxColor4(fx.color) + ');');
      }
      if (fx.offset) {
        var dist = Math.sqrt(fx.offset.x * fx.offset.x + fx.offset.y * fx.offset.y);
        var dir = Math.atan2(fx.offset.y, fx.offset.x) * 180 / Math.PI + 180;
        lines.push('shadow.property("ADBE Drop Shadow-0003").setValue(' + dir.toFixed(1) + ');');
        lines.push('shadow.property("ADBE Drop Shadow-0004").setValue(' + dist.toFixed(1) + ');');
      }
      lines.push('shadow.property("ADBE Drop Shadow-0005").setValue(' + (fx.radius || 0) + ');');
      if (fx.spread !== undefined) {
        lines.push('shadow.property("ADBE Drop Shadow-0006").setValue(' + fx.spread + ');');
      }
      if (fx.type === 'INNER_SHADOW') {
        // Shadow Only = off, then invert would need a workaround
        // AE Drop Shadow doesn't have native "inner" mode
        lines.push('// NOTE: Inner shadow approximated as drop shadow. AE lacks native inner shadow.');
      }
    } else if (fx.type === 'LAYER_BLUR') {
      lines.push('var blur = ' + layerVar + '.property("Effects").addProperty("ADBE Gaussian Blur 2");');
      lines.push('blur.property("ADBE Gaussian Blur 2-0001").setValue(' + (fx.radius || 0) + ');');
    }
  }
  return lines;
}

function generateTransform(layer, layerVar) {
  var lines = [];
  var x = (layer.x || 0) + (layer.width || 0) / 2;
  var y = (layer.y || 0) + (layer.height || 0) / 2;

  lines.push(layerVar + '.property("Transform").property("Position").setValue([' + x + ',' + y + ']);');

  if (layer.rotation) {
    lines.push(layerVar + '.property("Transform").property("Rotation").setValue(' + layer.rotation + ');');
  }
  if (layer.opacity !== undefined && layer.opacity !== 1) {
    lines.push(layerVar + '.property("Transform").property("Opacity").setValue(' + (layer.opacity * 100) + ');');
  }
  if (layer.blendMode && layer.blendMode !== 'NORMAL') {
    var bm = BLEND_MODES[layer.blendMode];
    if (bm) {
      lines.push(layerVar + '.blendingMode = ' + bm + ';');
    }
  }
  if (layer.visible === false) {
    lines.push(layerVar + '.enabled = false;');
  }

  return lines;
}

// ── Layer generators ──

function generateRectangle(layer, compVar) {
  var lines = [];
  var useSquircle = layer.cornerSmoothing && layer.cornerSmoothing > 0;
  var usePerCorner = Array.isArray(layer.cornerRadius);

  lines.push('var shapeLayer = ' + compVar + '.layers.addShape();');
  lines.push('shapeLayer.name = "' + jsxEsc(layer.name || 'Rectangle') + '";');
  lines.push('var grp = shapeLayer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");');

  if (useSquircle) {
    var r = typeof layer.cornerRadius === 'number' ? layer.cornerRadius : (layer.cornerRadius ? layer.cornerRadius[0] : 0);
    var pathData = generateSquirclePath(layer.width, layer.height, r, layer.cornerSmoothing);
    lines.push(generateShapePath(pathData));
    lines.push('var pathProp = grp.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group");');
    lines.push('pathProp.property("ADBE Vector Shape").setValue(s);');
  } else if (usePerCorner) {
    var pathData = generateRoundedRectPath(layer.width, layer.height, layer.cornerRadius);
    lines.push(generateShapePath(pathData));
    lines.push('var pathProp = grp.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group");');
    lines.push('pathProp.property("ADBE Vector Shape").setValue(s);');
  } else {
    lines.push('var rect = grp.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");');
    lines.push('rect.property("ADBE Vector Rect Size").setValue([' + layer.width + ',' + layer.height + ']);');
    if (layer.cornerRadius && typeof layer.cornerRadius === 'number') {
      lines.push('rect.property("ADBE Vector Rect Roundness").setValue(' + layer.cornerRadius + ');');
    }
  }

  lines = lines.concat(generateFills(layer, 'grp'));
  lines = lines.concat(generateStrokes(layer, 'grp'));
  lines = lines.concat(generateTransform(layer, 'shapeLayer'));
  lines = lines.concat(generateEffects(layer, 'shapeLayer'));

  return lines;
}

function generateEllipse(layer, compVar) {
  var lines = [];
  lines.push('var shapeLayer = ' + compVar + '.layers.addShape();');
  lines.push('shapeLayer.name = "' + jsxEsc(layer.name || 'Ellipse') + '";');
  lines.push('var grp = shapeLayer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");');
  lines.push('var ellipse = grp.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Ellipse");');
  lines.push('ellipse.property("ADBE Vector Ellipse Size").setValue([' + layer.width + ',' + layer.height + ']);');

  lines = lines.concat(generateFills(layer, 'grp'));
  lines = lines.concat(generateStrokes(layer, 'grp'));
  lines = lines.concat(generateTransform(layer, 'shapeLayer'));
  lines = lines.concat(generateEffects(layer, 'shapeLayer'));

  return lines;
}

function generatePath(layer, compVar) {
  var lines = [];
  if (!layer.path) return lines;

  lines.push('var shapeLayer = ' + compVar + '.layers.addShape();');
  lines.push('shapeLayer.name = "' + jsxEsc(layer.name || 'Path') + '";');
  lines.push('var grp = shapeLayer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");');
  lines.push(generateShapePath(layer.path));
  lines.push('var pathProp = grp.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group");');
  lines.push('pathProp.property("ADBE Vector Shape").setValue(s);');

  lines = lines.concat(generateFills(layer, 'grp'));
  lines = lines.concat(generateStrokes(layer, 'grp'));
  lines = lines.concat(generateTransform(layer, 'shapeLayer'));
  lines = lines.concat(generateEffects(layer, 'shapeLayer'));

  return lines;
}

function generateText(layer, compVar) {
  var lines = [];
  if (!layer.text) return lines;

  var content = jsxEsc(layer.text.content || '');
  lines.push('var textLayer = ' + compVar + '.layers.addText("' + content + '");');
  lines.push('textLayer.name = "' + jsxEsc(layer.name || 'Text') + '";');

  lines.push('var td = textLayer.property("Source Text").value;');
  if (layer.text.font && layer.text.font.family) {
    lines.push('td.font = "' + jsxEsc(layer.text.font.family) + '";');
  }
  if (layer.text.fontSize) {
    lines.push('td.fontSize = ' + layer.text.fontSize + ';');
  }
  if (layer.text.color) {
    lines.push('td.fillColor = ' + jsxColor(layer.text.color) + ';');
  }
  if (layer.text.justification) {
    var j = JUSTIFICATION[layer.text.justification] || JUSTIFICATION.LEFT;
    lines.push('td.justification = ' + j + ';');
  }
  if (layer.text.letterSpacing) {
    lines.push('td.tracking = ' + layer.text.letterSpacing + ';');
  }
  if (layer.text.lineHeight) {
    lines.push('td.leading = ' + layer.text.lineHeight + ';');
  }
  lines.push('td.applyFill = true;');
  lines.push('textLayer.property("Source Text").setValue(td);');

  lines = lines.concat(generateTransform(layer, 'textLayer'));
  lines = lines.concat(generateEffects(layer, 'textLayer'));

  return lines;
}

function generateGroup(layer, compVar, depth) {
  var lines = [];
  // Create null parent
  lines.push('var nullLayer = ' + compVar + '.layers.addNull();');
  lines.push('nullLayer.name = "' + jsxEsc(layer.name || 'Group') + '";');
  lines = lines.concat(generateTransform(layer, 'nullLayer'));

  // Create children, parent them
  if (layer.children && layer.children.length) {
    for (var i = 0; i < layer.children.length; i++) {
      var childLines = generateLayer(layer.children[i], compVar, depth + 1);
      lines = lines.concat(childLines);
      // Parent the last created layer to the null
      lines.push('var lastLayer = ' + compVar + '.layer(1);');
      lines.push('lastLayer.parent = nullLayer;');
    }
  }

  return lines;
}

function generateFrame(layer, compVar, depth) {
  var lines = [];

  if (layer.frameMode === 'precomp') {
    // Create a new comp and add children into it
    var name = jsxEsc(layer.name || 'Frame');
    lines.push('var frameComp = app.project.items.addComp("' + name + '", ' + layer.width + ', ' + layer.height + ', 1, ' + compVar + '.duration, ' + compVar + '.frameRate);');

    if (layer.children && layer.children.length) {
      for (var i = 0; i < layer.children.length; i++) {
        var childLines = generateLayer(layer.children[i], 'frameComp', depth + 1);
        lines = lines.concat(childLines);
      }
    }

    // Add precomp as layer in parent comp
    lines.push('var precompLayer = ' + compVar + '.layers.add(frameComp);');
    lines.push('precompLayer.name = "' + name + '";');
    lines = lines.concat(generateTransform(layer, 'precompLayer'));
  } else {
    // Default: null parent (same as group)
    lines = lines.concat(generateGroup(layer, compVar, depth));
  }

  return lines;
}

// ── Main dispatcher ──

function generateLayer(layer, compVar, depth) {
  depth = depth || 0;
  switch (layer.type) {
    case 'RECTANGLE': return generateRectangle(layer, compVar);
    case 'ELLIPSE': return generateEllipse(layer, compVar);
    case 'PATH': return generatePath(layer, compVar);
    case 'TEXT': return generateText(layer, compVar);
    case 'GROUP': return generateGroup(layer, compVar, depth);
    case 'FRAME': return generateFrame(layer, compVar, depth);
    default:
      return ['// Unsupported layer type: ' + (layer.type || 'unknown') + ' (' + (layer.name || '') + ')'];
  }
}

/**
 * Main entry point. Takes layer array and optional artboard, returns ExtendScript.
 */
export function translateToJSX(layers, artboard) {
  var lines = [];

  lines.push('(function() {');
  lines.push('var comp = app.project.activeItem;');
  lines.push('if (!(comp instanceof CompItem)) return JSON.stringify({ error: "No active composition" });');
  lines.push('var created = 0;');

  // Process layers in reverse order (Figma top = AE bottom)
  for (var i = layers.length - 1; i >= 0; i--) {
    lines.push('');
    lines.push('// --- Layer: ' + (layers[i].name || 'unnamed') + ' ---');
    var layerLines = generateLayer(layers[i], 'comp', 0);
    lines = lines.concat(layerLines);
    lines.push('created++;');
  }

  lines.push('');
  lines.push('return JSON.stringify({ ok: true, created: created });');
  lines.push('})()');

  return lines.join('\n');
}
