/** Resolved generator parameters of a pipe rack (06 STA M7), stored in `AssemblyElement.params` and replayed by update_pipe_rack. Lengths in document units. */

import { z } from '@core/commands/schema';

const point = z.tuple([z.number(), z.number()]);

export const rackSpecSchema = z.object({
  kind: z.literal('pipe_rack'),
  /** Plan point of the first bent on the first column line. */
  origin: point,
  /** Unit plan vector along the rack; the rack width extends to its left. */
  direction: point,
  along: z.union([
    z.object({ length: z.number().positive(), bentSpacing: z.number().positive() }),
    z.object({ stations: z.array(z.number().min(0)).min(2) }),
  ]),
  across: z.union([z.object({ width: z.number().positive() }), z.object({ baysAcross: z.array(z.number().positive()).min(1) })]),
  /** Top-of-steel elevations of the tier beams (and struts), level-relative, strictly ascending. */
  tiers: z.array(z.number()).min(1),
  columnProfile: z.string(),
  tierBeamProfile: z.string(),
  strutProfile: z.string(),
  struts: z.enum(['every_tier', 'top', 'none']),
  bracingBays: z.array(z.number().int().min(1)),
  bracingProfile: z.string().optional(),
  baseFixity: z.enum(['pinned', 'fixed']).optional(),
  gridPrefix: z.string(),
});

export type RackSpec = z.output<typeof rackSpecSchema>;

/** True when `params` parses as the resolved spec of a pipe rack. */
export const rackParamsValid = (params: unknown): boolean => rackSpecSchema.safeParse(params).success;
