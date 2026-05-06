export const JSX_CODE = `(function() {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) {
    return JSON.stringify({ error: "No active composition" });
  }
  var out = [];
  function walk(prop, layerName, layerIdx, path) {
    if (prop.numProperties !== undefined && prop.numProperties !== null) {
      for (var i = 1; i <= prop.numProperties; i++) {
        var child = prop.property(i);
        var childPath = path ? path + " > " + child.name : child.name;
        walk(child, layerName, layerIdx, childPath);
      }
    } else if (prop.canSetExpression && prop.expression) {
      out.push({
        layerIndex: layerIdx,
        layer: layerName,
        prop: path,
        matchName: prop.matchName,
        expression: prop.expression,
        enabled: prop.expressionEnabled,
        error: prop.expressionError || null
      });
    }
  }
  for (var i = 1; i <= comp.numLayers; i++) {
    var l = comp.layer(i);
    walk(l, l.name, l.index, "");
  }
  return JSON.stringify({ ok: true, comp: comp.name, count: out.length, expressions: out });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'listExpressions',
    {
      description:
        'Dump every expression in the active composition (recursively walks all layer properties). Returns layer, prop path, expression body, enabled state, error. Use to debug or audit expressions.',
      inputSchema: {
        onlyErrors: z.boolean().optional().describe('Return only expressions with errors'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ onlyErrors, aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'listExpressions', true, aeVersion);
        var parsed = JSON.parse(raw);
        var inner = parsed.ok && parsed.result ? JSON.parse(parsed.result) : parsed;
        if (inner.error) return { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: true };
        var exprs = onlyErrors ? inner.expressions.filter((x) => x.error) : inner.expressions;
        return { content: [{ type: 'text', text: JSON.stringify({ comp: inner.comp, count: exprs.length, expressions: exprs }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
      }
    }
  );
}
