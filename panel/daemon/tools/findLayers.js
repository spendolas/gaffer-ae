function buildJSX(query, scope, hasEffect, hasExpr) {
  var qJSON = JSON.stringify(query);
  var hasFxJSON = JSON.stringify(hasEffect || null);
  var hasExprJSON = JSON.stringify(hasExpr || null);
  return `(function() {
  var query = ${qJSON};
  var hasEffect = ${hasFxJSON};
  var hasExpr = ${hasExprJSON};
  var rx = null;
  try { rx = new RegExp(query, "i"); } catch (e) { return JSON.stringify({ error: "Invalid regex: " + e.toString() }); }

  function layerHasEffect(l, matchOrName) {
    var fx = l.property("ADBE Effect Parade");
    if (!fx) return false;
    for (var j = 1; j <= fx.numProperties; j++) {
      var eff = fx.property(j);
      if (eff.matchName === matchOrName || eff.name === matchOrName) return true;
    }
    return false;
  }

  function exprHit(prop, needle) {
    if (prop.numProperties !== undefined && prop.numProperties !== null) {
      for (var i = 1; i <= prop.numProperties; i++) {
        if (exprHit(prop.property(i), needle)) return true;
      }
      return false;
    }
    if (prop.canSetExpression && prop.expression && prop.expression.indexOf(needle) !== -1) return true;
    return false;
  }

  var hits = [];
  var comps = ${scope === 'active' ? '[]' : '[]'};
  var items = app.project.items;
  ${scope === 'active'
    ? 'var ai = app.project.activeItem; if (ai instanceof CompItem) comps.push(ai);'
    : 'for (var k = 1; k <= items.length; k++) { if (items[k] instanceof CompItem) comps.push(items[k]); }'}

  for (var c = 0; c < comps.length; c++) {
    var comp = comps[c];
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      var nameMatch = rx.test(l.name);
      var fxMatch = hasEffect ? layerHasEffect(l, hasEffect) : false;
      var exprMatch = hasExpr ? exprHit(l, hasExpr) : false;
      var match = nameMatch || fxMatch || exprMatch;
      if (!query && !hasEffect && !hasExpr) match = true;
      if (match) {
        hits.push({
          comp: comp.name,
          compId: comp.id,
          layerIndex: l.index,
          layerName: l.name,
          matchedName: nameMatch,
          matchedEffect: fxMatch,
          matchedExpression: exprMatch
        });
      }
    }
  }
  return JSON.stringify({ ok: true, count: hits.length, scopeComps: comps.length, hits: hits });
})()`;
}

export function register(server, queue, z) {
  server.registerTool(
    'findLayers',
    {
      description:
        'Search layers across project (or active comp only) by name regex, effect (matchName or display name), or expression substring. Returns comp + layer locations.',
      inputSchema: {
        nameRegex: z.string().optional().describe('Layer name regex (case-insensitive). Empty/omitted = match all.'),
        hasEffect: z.string().optional().describe('Restrict to layers with this effect (matchName like "ADBE Gaussian Blur 2" or display name)'),
        hasExpression: z.string().optional().describe('Restrict to layers with expressions containing this substring'),
        scope: z.enum(['project', 'active']).optional().describe('"project" (all comps) or "active" (active comp only). Default "project".'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ nameRegex, hasEffect, hasExpression, scope, aeVersion }) => {
      try {
        var s = scope || 'project';
        var raw = await queue.enqueue(buildJSX(nameRegex || '', s, hasEffect, hasExpression), 'findLayers', true, aeVersion);
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
