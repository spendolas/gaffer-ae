export const JSX_CODE = `(function() {
  var out = { ok: true };
  out.aeVersion = app.version;
  try { out.build = app.buildName + " " + app.buildNumber; } catch (e0) {}
  out.projectFile = app.project.file ? String(app.project.file.fsName) : null;
  out.dirty = app.project.dirty === true;
  try { out.bitsPerChannel = app.project.bitsPerChannel; } catch (e1) {}
  try { out.workingSpace = app.project.workingSpace; } catch (e2) {}
  try { out.linearizeWorkingSpace = app.project.linearizeWorkingSpace; } catch (e3) {}
  try { out.linearBlending = app.project.linearBlending; } catch (e4) {}
  try { out.expressionEngine = app.project.expressionEngine; } catch (e5) {}
  try {
    out.timeDisplayType = app.project.timeDisplayType === TimeDisplayType.FRAMES ? "frames" : "timecode";
  } catch (e6) {}
  try { out.framesUseFeetFrames = app.project.framesUseFeetFrames; } catch (e7) {}
  try { out.displayStartFrame = app.project.displayStartFrame; } catch (e8) {}
  try {
    var gpu = app.project.gpuAccelType;
    var names = {};
    names[GpuAccelType.CUDA] = "CUDA";
    names[GpuAccelType.METAL] = "Metal";
    names[GpuAccelType.OPENCL] = "OpenCL";
    names[GpuAccelType.SOFTWARE] = "Software";
    out.gpuAccelType = names[gpu] || String(gpu);
    var avail = [];
    var list = app.availableGPUAccelTypes;
    for (var i = 0; i < list.length; i++) avail.push(names[list[i]] || String(list[i]));
    out.availableGPUAccelTypes = avail;
  } catch (e9) {}
  try { out.numItems = app.project.numItems; } catch (e10) {}
  try { out.renderQueueItems = app.project.renderQueue.numItems; } catch (e11) {}
  try { out.activeItem = app.project.activeItem ? app.project.activeItem.name : null; } catch (e12) {}
  try { out.memoryInUseGB = Math.round(app.memoryInUse / 1073741824 * 100) / 100; } catch (e13) {}
  return JSON.stringify(out);
})()`;

export function register(server, queue, z) {
  server.registerTool(
    'getProjectSettings',
    {
      description:
        'Project + host environment settings: AE version/build, project file path and dirty flag, color depth (bpc), working color space and linearization, expression engine, time display, GPU acceleration (current + available), item/render-queue counts, memory in use. Use before color-sensitive or engine-sensitive work.',
      inputSchema: {
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open.'),
      },
    },
    async ({ aeVersion } = {}) => {
      try {
        var raw = await queue.enqueue(JSX_CODE, 'getProjectSettings', true, aeVersion);
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
