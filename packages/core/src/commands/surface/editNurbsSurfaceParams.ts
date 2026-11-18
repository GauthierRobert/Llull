import { FALLOFF_SHAPES } from '../../lib/falloff';
import { vec3, z } from '../schema';

const EDIT_OPERATIONS = ['move_poles', 'set_weight', 'drag_point', 'insert_knot', 'elevate_degree', 'reverse', 'transpose'] as const;

export const editNurbsSurfaceParams = z.object({
  id: z.string().describe('Id of a nurbs_surface entity.'),
  operation: z.enum(EDIT_OPERATIONS).describe('Which edit to apply; the other params depend on it.'),
  poles: z
    .array(z.tuple([z.number().int(), z.number().int()]))
    .describe('move_poles: selected poles as [i, j] index pairs.')
    .optional(),
  rows: z.array(z.number().int()).describe('move_poles: select every pole of these u-rows (first index i).').optional(),
  cols: z.array(z.number().int()).describe('move_poles: select every pole of these v-columns (second index j).').optional(),
  rect: z
    .object({
      i0: z.number().int().describe('First row (inclusive).'),
      i1: z.number().int().describe('Last row (inclusive).'),
      j0: z.number().int().describe('First column (inclusive).'),
      j1: z.number().int().describe('Last column (inclusive).'),
    })
    .describe('move_poles: select the block of poles i0..i1, j0..j1.')
    .optional(),
  delta: vec3(
    'move_poles: translation [x, y, z] added to each selected pole, in the entity-local frame (before the entity rotation), document units.',
  ).optional(),
  falloff: z
    .object({
      radiusU: z.number().min(0).describe('Falloff radius along u in pole-index units (0 = no spread along u).'),
      radiusV: z.number().min(0).describe('Falloff radius along v in pole-index units (0 = no spread along v).'),
      shape: z.enum(FALLOFF_SHAPES).describe('Weight curve, default smooth.').optional(),
    })
    .describe('move_poles: soft selection; distance is max(|di| / radiusU, |dj| / radiusV) to the nearest selected pole.')
    .optional(),
  i: z.number().int().describe('set_weight: pole row index (along u).').optional(),
  j: z.number().int().describe('set_weight: pole column index (along v).').optional(),
  weight: z.number().describe('set_weight: new weight, finite and > 0.').optional(),
  u: z
    .number()
    .describe('drag_point: parameter along u. insert_knot with direction "u": the knot to insert (strictly inside the domain).')
    .optional(),
  v: z
    .number()
    .describe('drag_point: parameter along v. insert_knot with direction "v": the knot to insert (strictly inside the domain).')
    .optional(),
  displacement: vec3('drag_point: how far S(u, v) moves [x, y, z] in document units.').optional(),
  direction: z.enum(['u', 'v']).describe('insert_knot / elevate_degree / reverse: the parameter direction.').optional(),
  times: z.number().int().describe('insert_knot: how many times to insert the knot, default 1.').optional(),
  by: z.number().int().describe('elevate_degree: how many degrees to add, default 1.').optional(),
});

export type EditParams = z.infer<typeof editNurbsSurfaceParams>;
