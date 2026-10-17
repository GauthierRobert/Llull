/** Params shared by select_fastener, insert_fastener_stack and insert_fastener_row (one selection vocabulary, 08 MAT TECHNICAL_SPEC §4.2). */

import { vec3, z } from '@core/commands/schema';

export const quantity = (what: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  z
    .object({
      value: z.number().describe('Length magnitude, expressed in `unit`.'),
      unit: z.string().describe("Length unit of the value, e.g. 'in', 'mm', 'ft'."),
    })
    .describe(what);

/** Fields every selection shares, whether the stack is a number, measured once or measured at every row position. */
export const sharedFields = {
  family: z
    .string()
    .describe(
      'Id of the fastener family in the document catalogue (e.g. "NAS6203-6220", "MS20470", "HL19"). Use list_fastener_families to see ids.',
    ),
  diameterDash: z
    .string()
    .describe(
      'Size dash of the family as listed by list_fastener_families (e.g. "3" for NAS6203, "4" for MS20470AD4, "8" for HL19 1/4 in).',
    ),
  axis: vec3('Fastener axis direction [x, y, z] pointing from the head side to the nut side. Default [0, 0, 1].').optional(),
  nut: z
    .string()
    .describe('Optional nut family id (e.g. "MS21042") for the same diameter dash; enables the thread-protrusion check.')
    .optional(),
  washer: z.string().describe('Optional washer family id (e.g. "NAS1149") used to shim the gap between grip and stack.').optional(),
  washerSide: z.enum(['nut', 'head']).describe('Side of the stack the shim washers go on: "nut" (default) or "head".').optional(),
  maxWasherTotal: quantity(
    'Largest combined washer thickness allowed as { value, unit }. Default 1/8 in (AC 43.13-1B 7-37), reported as a defaulted rule',
  ).optional(),
  codes: z
    .record(z.string(), z.string())
    .describe(
      'Part-number code choices by grammar field name, e.g. { "material": "AD" } for MS20470AD4. A missing choice takes the first catalogue code and is reported.',
    )
    .optional(),
  rivetRounding: z
    .enum(['up', 'nearest'])
    .describe(
      'Rivet length rounding to the catalogue step: "up" or "nearest". Default: the catalogue rule (up), reported as a defaulted rule.',
    )
    .optional(),
};

/** How the stack thickness is given: a number, or solids measured along an axis. */
const stackFields = {
  stack: quantity('Stack thickness to fasten (total thickness of the joined layers) as { value, unit }. Give this OR stackIds').optional(),
  stackIds: z
    .array(z.string())
    .describe(
      'Ids of the 3D solids (plates) the fastener passes through; their thickness along the axis is measured. Give this OR stack. Needs axisPoint.',
    )
    .optional(),
  axisPoint: vec3(
    'Point [x, y, z] in document units the fastener axis passes through (with stackIds). Not required with stack.',
  ).optional(),
};

export const selectionFields = { ...sharedFields, ...stackFields };

export const selectionSchema = z.object(selectionFields);

export type SelectionParams = z.output<typeof selectionSchema>;
