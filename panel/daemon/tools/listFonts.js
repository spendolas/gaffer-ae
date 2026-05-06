/**
 * listFonts — installed fonts available to AE text layers.
 * Requires AE 24.0+ (app.fonts API). Older versions return error.
 */
export const JSX_CODE = `(function() {
  if (!app.fonts || !app.fonts.allFonts) {
    return JSON.stringify({ error: "app.fonts API requires AE 24.0+" });
  }
  var all = app.fonts.allFonts;
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var f = all[i];
    out.push({
      family: f.family || "",
      style: f.style || "",
      postScriptName: f.postScriptName || "",
      hasItalic: !!f.hasItalic,
      hasBold: !!f.hasBold
    });
  }
  return JSON.stringify({ ok: true, count: out.length, fonts: out });
})()`;

var cache = null;

export function register(server, queue, z) {
  server.registerTool(
    'listFonts',
    {
      description:
        'List installed fonts available to text layers. Use postScriptName when creating/setting TextDocument fonts (display names often fail). Cached after first call.',
      inputSchema: {
        family: z.string().optional().describe('Filter by family name (case-insensitive substring match)'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open. Omit if only one AE is open.'),
      },
    },
    async ({ family, aeVersion } = {}) => {
      try {
        if (!cache) {
          var raw = await queue.enqueue(JSX_CODE, 'listFonts', true, aeVersion);
          var parsed = JSON.parse(raw);
          var inner = parsed.ok && parsed.result ? JSON.parse(parsed.result) : parsed;
          if (inner.error) return { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: true };
          cache = inner.fonts;
        }
        var out = cache;
        if (family) {
          var f = family.toLowerCase();
          out = cache.filter((x) => (x.family || '').toLowerCase().indexOf(f) !== -1);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ count: out.length, fonts: out }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
      }
    }
  );
}
