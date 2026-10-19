/** zod building blocks of the topology commands. */

import type { TopologyRegion } from '@core/model/topology';
import { vec3, z } from '@core/commands/schema';
import { feaTargetSchema, toTarget } from '../shared/target';

export const studyIdSchema = z.string().describe('Id of the topology study (affected[0] of create_topology_study, e.g. ts-3.1).');

const targetSchema = feaTargetSchema.omit({ intersectPlane: true });

export const regionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('box').describe('All voxels whose centre lies in an axis-aligned box.'),
    min: vec3('Box minimum corner [x, y, z], world coordinates in document units.'),
    max: vec3('Box maximum corner [x, y, z], world coordinates in document units.'),
  }),
  z.object({
    kind: z
      .literal('entity')
      .describe('All voxels whose centre lies inside another solid (an interface boss, a bolt boss, a keep-out volume).'),
    entityId: z.string().describe('Id of an existing 3D solid.'),
  }),
  z.object({
    kind: z.literal('target').describe('The layers of voxels next to a face / edge / point of a part (a bearing seat, a loaded face).'),
    target: targetSchema.describe(
      'Same targets as add_fea_constraint: points that identify faces / edges / points of a design-domain entity.',
    ),
    depthVoxels: z.number().int().min(1).optional().describe('Layers of voxels next to the target, at least 1. Default 1.'),
  }),
]);

export type RegionInput = z.output<typeof regionSchema>;

/** `TopologyRegion` from validated input (defaults filled in). */
export function toRegion(input: RegionInput): TopologyRegion {
  if (input.kind === 'target') return { kind: 'target', target: toTarget(input.target), depthVoxels: input.depthVoxels ?? 1 };
  return input;
}
