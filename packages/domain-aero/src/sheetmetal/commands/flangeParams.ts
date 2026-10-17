import { z, vec3 } from '@core/commands/schema';

const REFERENCES = ['outside_mold_line', 'inside_mold_line', 'tangent'] as const;
const POSITIONS = ['material_inside', 'material_outside', 'bend_outside'] as const;

/** Parameters of an edge flange (shared by `add_flange` and the hem). */
export const flangeParams = z.object({
  id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
  edge: z
    .object({
      near: vec3('World point [x, y, z] on or within one thickness of the straight edge that receives the flange (document length unit).'),
    })
    .describe('Edge selector.'),
  angle: z
    .number()
    .describe(
      'Bend angle in degrees: the angle bent THROUGH (0 = flat, 90 = right angle). 0 < angle <= 180; 180 only with lengthReference tangent.',
    ),
  length: z.number().describe('Flange length in the document length unit, measured as lengthReference says; must leave a flat leg > 0.'),
  lengthReference: z
    .enum(REFERENCES)
    .describe("Where `length` ends at the bend: 'outside_mold_line', 'inside_mold_line' or 'tangent' (the bend tangent line)."),
  position: z
    .enum(POSITIONS)
    .describe("Where the picked edge sits relative to the bend: 'material_outside', 'material_inside' or 'bend_outside'."),
  direction: z
    .enum(['up', 'down'])
    .optional()
    .describe("Bend towards the flat's +normal face ('up', default) or the -normal face ('down')."),
  insideRadius: z.number().optional().describe('Inside bend radius in the document length unit; default the rule radius; >= 0.'),
  widthStart: z.number().optional().describe('Inset of the flange from the edge start, in the document length unit (>= 0, default 0).'),
  widthEnd: z.number().optional().describe('Inset of the flange from the edge end, in the document length unit (>= 0, default 0).'),
  autoRelief: z
    .boolean()
    .optional()
    .describe(
      "Default true: when the rule defines a rectangular relief, cut it automatically at each end of the new bend that stops short of the edge end (width = widthRatio x thickness, depth = inside radius + thickness + depthExtra, all in the document length unit; the result's data.reliefs names the defaulted values). false = leave the bend ends unrelieved (check_sheet_metal then warns FTR_RELIEF_MISSING).",
    ),
});
