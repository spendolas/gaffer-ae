export const JSX_CODE = `(function() {
  // RQItemStatus enum values: WILL_CONTINUE=2, NEEDS_OUTPUT=3, UNQUEUED=4, QUEUED=5, RENDERING=6, USER_STOPPED=7, ERR_STOPPED=8, DONE=9
  var statusMap = {
    2: "WILL_CONTINUE",
    3: "NEEDS_OUTPUT",
    4: "UNQUEUED",
    5: "QUEUED",
    6: "RENDERING",
    7: "USER_STOPPED",
    8: "ERR_STOPPED",
    9: "DONE"
  };
  var rq = app.project.renderQueue;
  var out = [];
  for (var i = 1; i <= rq.numItems; i++) {
    var item = rq.item(i);
    var modules = [];
    for (var j = 1; j <= item.numOutputModules; j++) {
      var om = item.outputModule(j);
      modules.push({
        index: j,
        name: om.name,
        file: (om.file && om.file.fsName) ? om.file.fsName : null,
        templates: om.templates ? om.templates.length : 0
      });
    }
    out.push({
      index: i,
      compName: item.comp.name,
      status: statusMap[item.status] || ("UNKNOWN_" + item.status),
      timeSpanStart: item.timeSpanStart,
      timeSpanDuration: item.timeSpanDuration,
      skipFrames: item.skipFrames,
      logType: item.logType,
      outputModules: modules
    });
  }
  return JSON.stringify({ ok: true, rendering: rq.rendering, count: out.length, items: out });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'getRenderQueue',
    {
      description:
        'Get current render queue state: each item with comp, status (QUEUED/RENDERING/DONE/etc), time span, output modules + paths. Read-only.',
      inputSchema: {
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'getRenderQueue', true, aeVersion);
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
