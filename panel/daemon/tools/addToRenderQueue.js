function buildJSX(compId, outputPath, templateName) {
  var compResolve = compId
    ? `var comp = app.project.itemByID(${compId}); if (!(comp instanceof CompItem)) return JSON.stringify({ error: "No comp with id ${compId}" });`
    : `var comp = app.project.activeItem; if (!(comp instanceof CompItem)) return JSON.stringify({ error: "No active composition" });`;
  var pathJSON = JSON.stringify(outputPath);
  var tplJSON = JSON.stringify(templateName || null);
  return `(function() {
  ${compResolve}
  var rq = app.project.renderQueue;
  var rqItem = rq.items.add(comp);
  var om = rqItem.outputModule(1);
  var tpl = ${tplJSON};
  if (tpl) {
    var found = false;
    var templates = om.templates;
    for (var i = 0; i < templates.length; i++) {
      if (templates[i] === tpl) { found = true; break; }
    }
    if (!found) {
      try { rqItem.remove(); } catch (e) {}
      return JSON.stringify({ error: "Template not found: " + tpl + ". Available: " + templates.join(", ") });
    }
    om.applyTemplate(tpl);
  }
  try {
    om.file = new File(${pathJSON});
  } catch (e) {
    return JSON.stringify({ error: "Failed to set output file: " + e.toString() });
  }
  return JSON.stringify({
    ok: true,
    rqIndex: rqItem.index,
    comp: comp.name,
    output: om.file ? om.file.fsName : null,
    template: om.name
  });
})()`;
}

export function register(server, queue, z) {
  server.registerTool(
    'addToRenderQueue',
    {
      description:
        'Add a composition to the render queue with output path and optional template. Does NOT start rendering — use AE UI or runJSX with app.project.renderQueue.render() (destructive).',
      inputSchema: {
        compId: z.number().optional().describe('Comp id (from listCompositions). Omit for active comp.'),
        outputPath: z.string().describe('Absolute output file path'),
        template: z.string().optional().describe('Output module template name (e.g. "Lossless", "H.264 - Match Render Settings - 15 Mbps"). Omit for current default.'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ compId, outputPath, template, aeVersion }) => {
      try {
        var raw = await queue.enqueue(buildJSX(compId ?? null, outputPath, template), 'addToRenderQueue', false, aeVersion);
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
