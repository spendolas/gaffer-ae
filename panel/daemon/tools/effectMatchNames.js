/**
 * listEffectMatchNames tool — inlines ExtendScript, caches result in daemon.
 */
export const JSX_CODE = `(function() {
  var result = {};
  for (var i = 0; i < app.effects.length; i++) {
    var eff = app.effects[i];
    var cat = eff.category || "Uncategorized";
    if (!result[cat]) result[cat] = [];
    result[cat].push({ displayName: eff.displayName, matchName: eff.matchName });
  }
  return JSON.stringify(result);
})()`;

var cache = null;

export function register(server, queue, z) {
  server.registerTool(
    'listEffectMatchNames',
    {
      description:
        'List all available effect match names in the running AE instance, grouped by category. Use this to find the correct match name before applying effects. Match names != display names.',
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe('Filter by category name (case-insensitive substring match)'),
      },
    },
    async ({ category }) => {
      try {
        if (!cache) {
          var raw = await queue.enqueue(JSX_CODE, 'listEffectMatchNames');
          // Safety wrapper returns: {"ok":true,"result":"<json-string>"}
          var parsed = JSON.parse(raw);
          if (parsed.ok === false) {
            return { content: [{ type: 'text', text: raw }], isError: true };
          }
          if (parsed.ok === true && parsed.result) {
            cache = JSON.parse(parsed.result);
          } else {
            cache = parsed;
          }
        }

        var output = cache;
        if (category) {
          var filter = category.toLowerCase();
          output = {};
          for (var cat in cache) {
            if (cat.toLowerCase().indexOf(filter) !== -1) {
              output[cat] = cache[cat];
            }
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }],
          isError: true,
        };
      }
    }
  );
}
