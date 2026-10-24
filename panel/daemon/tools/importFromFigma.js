/**
 * importFromFigma tool — accepts Figma layer data (typically read from Grip, the
 * live Figma connection, and reshaped to this schema), generates ExtendScript,
 * creates matching AE layers deterministically.
 *
 * NOTE: the string the model actually sees is the `description` field on the
 * registerTool call below, NOT this JSDoc — keep the two in sync by hand. Don't
 * name specific Grip tools in either; they can change and the agent discovers them.
 */
import { translateToJSX } from './figma-translator.js';
import { closedObject } from '../closed-object.js';

export function register(server, queue, z) {
  // Closed objects, like the zod 3 tools/list contract (see closed-object.js).
  var obj = (shape) => closedObject(z, shape);
  var LayerSchema = z.lazy(() =>
    obj({
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
      path: obj({
        vertices: z.array(z.array(z.number())),
        inTangents: z.array(z.array(z.number())),
        outTangents: z.array(z.array(z.number())),
        closed: z.boolean(),
      }).optional(),
      fills: z.array(obj({
        type: z.enum(['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL']),
        color: obj({ r: z.number(), g: z.number(), b: z.number() }).optional(),
        opacity: z.number().optional(),
        stops: z.array(obj({
          color: obj({ r: z.number(), g: z.number(), b: z.number() }),
          position: z.number(),
          opacity: z.number().optional(),
        })).optional(),
      })).optional(),
      strokes: z.array(obj({
        color: obj({ r: z.number(), g: z.number(), b: z.number() }),
        width: z.number(),
        opacity: z.number().optional(),
        cap: z.enum(['BUTT', 'ROUND', 'SQUARE']).optional(),
        join: z.enum(['MITER', 'ROUND', 'BEVEL']).optional(),
        dashes: z.array(z.number()).optional(),
      })).optional(),
      effects: z.array(obj({
        type: z.enum(['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR']),
        color: obj({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }).optional(),
        offset: obj({ x: z.number(), y: z.number() }).optional(),
        radius: z.number(),
        spread: z.number().optional(),
      })).optional(),
      text: obj({
        content: z.string(),
        fontSize: z.number(),
        font: obj({ family: z.string(), style: z.string().optional() }),
        color: obj({ r: z.number(), g: z.number(), b: z.number() }).optional(),
        justification: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
        lineHeight: z.number().optional(),
        letterSpacing: z.number().optional(),
        boxWidth: z.number().optional(),
      }).optional(),
      children: z.array(LayerSchema).optional(),
    })
  );

  server.registerTool(
    'importFromFigma',
    {
      description:
        'Import Figma layers into After Effects. Creates matching AE layers deterministically from structured layer data. Read the design from Grip first (the live, preferred Figma connection), reshape that result into the layers schema below, then pass it here. A REST-based Figma connector can also supply this data, but only for published content and it cannot edit the canvas.',
      inputSchema: {
        layers: z.array(LayerSchema).describe('Array of Figma layer objects to create in AE'),
        artboard: obj({
          width: z.number(),
          height: z.number(),
          name: z.string().optional(),
        }).optional().describe('Artboard dimensions. If provided and no active comp matches, a new comp is created.'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open. Omit if only one AE is open.'),
      },
    },
    async ({ layers, artboard, aeVersion }) => {
      try {
        var jsx = translateToJSX(layers, artboard);
        var result = await queue.enqueue(jsx, 'importFromFigma', false, aeVersion);
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
