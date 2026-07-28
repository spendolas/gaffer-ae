export const JSX_CODE = `(function() {
  var items = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    var entry = { id: item.id, name: item.name };
    try { entry.parentId = item.parentFolder ? item.parentFolder.id : null; } catch (e0) { entry.parentId = null; }
    if (item instanceof FolderItem) {
      entry.type = "folder";
      entry.numItems = item.numItems;
    } else if (item instanceof CompItem) {
      entry.type = "comp";
      entry.width = item.width;
      entry.height = item.height;
      entry.duration = item.duration;
      entry.frameRate = item.frameRate;
      entry.numLayers = item.numLayers;
    } else if (item instanceof FootageItem) {
      entry.type = "footage";
      try {
        if (item.mainSource instanceof SolidSource) {
          entry.type = "solid";
          entry.color = item.mainSource.color;
        } else if (item.mainSource instanceof PlaceholderSource) {
          entry.type = "placeholder";
        } else if (item.mainSource instanceof FileSource) {
          entry.file = item.mainSource.file ? String(item.mainSource.file.fsName) : null;
          entry.missing = item.footageMissing === true;
        }
      } catch (e1) { /* source type probing failed */ }
      try { entry.usedIn = item.usedIn.length; } catch (e2) {}
    } else {
      entry.type = "other";
    }
    try { if (item.label !== undefined) entry.label = item.label; } catch (e3) {}
    items.push(entry);
  }
  // root folder id for reconstructing the hierarchy
  var rootId = null;
  try { rootId = app.project.rootFolder.id; } catch (e4) {}
  return JSON.stringify({ ok: true, projectName: app.project.file ? String(app.project.file.name) : "(unsaved)", rootFolderId: rootId, count: items.length, items: items });
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'getProjectTree',
    {
      description:
        'The full project-panel hierarchy as a flat list with parent ids: folders, comps (dims/fps/duration/layers), footage (file path, missing flag, usage count), solids, placeholders, label colors. Reconstruct the tree via parentId/rootFolderId. Complements the flat listCompositions/listFootage views.',
      inputSchema: {
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'getProjectTree', true, aeVersion);
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
