/**
 * importFromFigma tool — accepts Figma layer data, generates ExtendScript,
 * creates matching AE layers deterministically.
 */
import { translateToJSX } from './figma-translator.js';

export function register(server, queue, z) {
  var LayerSchema = z.lazy(() =>
    z.object({
      name: z.string(),
      type: z.enum(['RECTANGLE', 'ELLIPSE', 'PATH', 'TEXT', 'FRAME', 'GROUP']),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      rotation: z.number().optional(),
      opacity: z.number().optional(),
      visible: z.boolean().optional(),
      blendMode: z.string().optional(),
      cornerRadius: z.union([z.number(), z.array(z.number())]).optional(),
      cornerSmoothing: z.number().optional(),
      frameMode: z.enum(['precomp', 'null']).optional(),
      path: z.object({
        vertices: z.array(z.array(z.number())),
        inTangents: z.array(z.array(z.number())),
        outTangents: z.array(z.array(z.number())),
        closed: z.boolean(),
      }).optional(),
      fills: z.array(z.object({
        type: z.enum(['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL']),
        color: z.object({ r: z.number(), g: z.number(), b: z.number() }).optional(),
        opacity: z.number().optional(),
        stops: z.array(z.object({
          color: z.object({ r: z.number(), g: z.number(), b: z.number() }),
          position: z.number(),
          opacity: z.number().optional(),
        })).optional(),
      })).optional(),
      strokes: z.array(z.object({
        color: z.object({ r: z.number(), g: z.number(), b: z.number() }),
        width: z.number(),
        opacity: z.number().optional(),
        cap: z.enum(['BUTT', 'ROUND', 'SQUARE']).optional(),
        join: z.enum(['MITER', 'ROUND', 'BEVEL']).optional(),
        dashes: z.array(z.number()).optional(),
      })).optional(),
      effects: z.array(z.object({
        type: z.enum(['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR']),
        color: z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }).optional(),
        offset: z.object({ x: z.number(), y: z.number() }).optional(),
        radius: z.number(),
        spread: z.number().optional(),
      })).optional(),
      text: z.object({
        content: z.string(),
        fontSize: z.number(),
        font: z.object({ family: z.string(), style: z.string().optional() }),
        color: z.object({ r: z.number(), g: z.number(), b: z.number() }).optional(),
        justification: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
        lineHeight: z.number().optional(),
        letterSpacing: z.number().optional(),
        boxWidth: z.number().optional(),
      }).optional(),
      children: z.array(z.lazy(() => LayerSchema)).optional(),
    })
  );

  server.registerTool(
    'importFromFigma',
    {
      description:
        'Import Figma layers into After Effects. Creates matching AE layers deterministically from structured layer data. Call Figma MCP get_design_context first to get the design, then format the result into the layers schema and pass it here.',
      inputSchema: {
        layers: z.array(LayerSchema).describe('Array of Figma layer objects to create in AE'),
        artboard: z.object({
          width: z.number(),
          height: z.number(),
          name: z.string().optional(),
        }).optional().describe('Artboard dimensions. If provided and no active comp matches, a new comp is created.'),
      },
    },
    async ({ layers, artboard }) => {
      try {
        var jsx = translateToJSX(layers, artboard);
        var result = await queue.enqueue(jsx, 'importFromFigma');
        return { content: [{ type: 'text', text: result }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }],
          isError: true,
        };
      }
    }
  );
}
