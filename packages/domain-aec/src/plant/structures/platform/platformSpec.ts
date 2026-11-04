/** Resolved generator parameters of a platform assembly (06 STA M6), stored in `AssemblyElement.params` and replayed by update_access_platform. */

import { z } from '@core/commands/schema';
import type { AssemblyKind } from '@aec/building/types';

const point = z.tuple([z.number(), z.number()]);

const railingFields = {
  height: z.number().positive(),
  kneeRails: z.number().int().min(0).max(10),
  toePlate: z.number().min(0),
  postProfile: z.string(),
  railProfile: z.string(),
  postSpacingMax: z.number().positive(),
  openings: z.array(z.object({ from: z.number().min(0), to: z.number().positive(), gate: z.boolean() })).optional(),
};

export const platformSpecSchema = z.object({
  kind: z.literal('platform'),
  boundary: z.array(point).min(3),
  topOffset: z.number(),
  gratingType: z.string(),
  bearingBarDirection: point,
  imposedLoadKPa: z.number().min(0).optional(),
  framing: z.union([
    z.object({ kind: z.literal('existing') }),
    z.object({ kind: z.literal('generated'), profile: z.string(), maxSpacing: z.number().positive() }),
  ]),
  railing: z.union([z.null(), z.object({ edges: z.union([z.literal('all'), z.array(z.number().int().min(0))]), ...railingFields })]),
});

export const circularSpecSchema = z.object({
  kind: z.literal('circular_platform'),
  equipmentId: z.string(),
  elevation: z.number(),
  startAngleDeg: z.number(),
  sweepDeg: z.number().positive().max(360),
  gap: z.number().min(0),
  width: z.number().positive(),
  gratingType: z.string(),
  imposedLoadKPa: z.number().min(0).optional(),
  bracketProfile: z.string(),
  bracketSpacingMax: z.number().positive().optional(),
  railing: z.union([z.null(), z.object({ edges: z.array(z.enum(['outer', 'inner', 'ends'])), ...railingFields })]),
  /** The vessel as the parts were derived from it (stored by the generator; absent in the command input): a later difference means the platform is stale. */
  vessel: z.object({ centre: point, diameter: z.number(), height: z.number() }).optional(),
});

export type PlatformSpec = z.output<typeof platformSpecSchema>;
export type CircularSpec = z.output<typeof circularSpecSchema>;
export type RailingSpecFields = Omit<NonNullable<PlatformSpec['railing']>, 'edges'>;

/** True when `params` parses as the resolved spec of `kind`. */
export const platformParamsValid = (kind: AssemblyKind, params: unknown): boolean =>
  (kind === 'platform' ? platformSpecSchema : circularSpecSchema).safeParse(params).success;
