/** zod building blocks of the topology commands. */

import type { TopologyObjective, TopologyRegion } from '@core/model/topology';
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

const loadCaseWeightsSchema = z
  .record(z.string(), z.number())
  .optional()
  .describe('Weight of each load case name in the weighted compliance; a case not listed weighs 1.');

export const objectiveSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('min_compliance').describe('Minimise the weighted compliance (maximise stiffness) within the volume fraction.'),
    loadCaseWeights: loadCaseWeightsSchema,
  }),
  z.object({
    kind: z
      .literal('min_volume')
      .describe('Minimise the material while the weighted compliance stays at or below maxCompliance (needs optimizer mma).'),
    maxCompliance: z
      .number()
      .describe('Largest allowed weighted compliance, in the force x length unit of the analysis unit system (N-mm-t-s: N*mm), > 0.'),
    loadCaseWeights: loadCaseWeightsSchema,
  }),
]);

export type ObjectiveInput = z.output<typeof objectiveSchema>;

/** The weight of `objective.loadCaseWeights` that is not > 0, if any. */
export function badWeight(objective: ObjectiveInput): [string, number] | undefined {
  return Object.entries(objective.loadCaseWeights ?? {}).find(([, weight]) => !(weight > 0) || !Number.isFinite(weight));
}

/** `TopologyObjective` from validated input; `unit` is the compliance unit of the analysis (force x length). */
export function toObjective(input: ObjectiveInput, unit: string): TopologyObjective {
  const loadCaseWeights = input.loadCaseWeights ?? {};
  return input.kind === 'min_volume'
    ? { kind: 'min_volume', maxCompliance: input.maxCompliance, unit, loadCaseWeights }
    : { kind: 'min_compliance', loadCaseWeights };
}
