/** zod building blocks of the topology commands. */

import type { TopologyDisplacementConstraint, TopologyObjective, TopologyRegion } from '@core/model/topology';
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

const displacementConstraintSchema = z.object({
  label: z
    .string()
    .optional()
    .describe('Name shown in the constraint report (unique in the study). Default u<axis>-<position>, e.g. uy-1.'),
  target: targetSchema.describe(
    'A face / edge / point of a design-domain entity (same selectors as keep-in regions); the mean displacement of the grid nodes it maps to is limited.',
  ),
  component: z.enum(['ux', 'uy', 'uz']).describe('World axis of the displacement component that is limited.'),
  maxDisplacement: z
    .number()
    .describe('Largest allowed absolute mean displacement of the target nodes along the component, in document length units, > 0.'),
  loadCase: z
    .string()
    .optional()
    .describe('Load case name the limit applies to. Default: every load case of the analysis (one constraint each).'),
});

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
    displacementConstraints: z
      .array(displacementConstraintSchema)
      .optional()
      .describe(
        'Extra limits on the displacement of a face / edge / point, e.g. the tip deflection (each |mean u| <= maxDisplacement, in the loaded state). ' +
          'Each is one more constraint of the MMA solve (an adjoint solve per constraint and iteration) and a row of the constraint report. Default none.',
      ),
  }),
]);

export type ObjectiveInput = z.output<typeof objectiveSchema>;

/** The weight of `objective.loadCaseWeights` that is not > 0, if any. */
export function badWeight(objective: ObjectiveInput): [string, number] | undefined {
  return Object.entries(objective.loadCaseWeights ?? {}).find(([, weight]) => !(weight > 0) || !Number.isFinite(weight));
}

/** The first problem of the displacement constraints of `objective` (empty list and min_compliance have none), or undefined. */
export function displacementProblem(
  objective: ObjectiveInput,
  designDomain: readonly string[],
): { readonly message: string; readonly path: string } | undefined {
  if (objective.kind !== 'min_volume') return undefined;
  const seen = new Set<string>();
  for (const [index, constraint] of (objective.displacementConstraints ?? []).entries()) {
    const path = `objective.displacementConstraints.${index}`;
    if (!(constraint.maxDisplacement > 0 && Number.isFinite(constraint.maxDisplacement)))
      return { message: `maxDisplacement ${constraint.maxDisplacement} must be > 0`, path: `${path}.maxDisplacement` };
    const { target } = constraint;
    if ([target.facesNear, target.edgesNear, target.pointsNear].every((points) => points === undefined || points.length === 0))
      return { message: 'target needs at least one of facesNear / edgesNear / pointsNear', path: `${path}.target` };
    if (!designDomain.includes(target.entityId))
      return { message: `target entity '${target.entityId}' is not in the design domain`, path: `${path}.target.entityId` };
    const label = displacementLabel(constraint, index);
    if (seen.has(label)) return { message: `duplicate displacement constraint label '${label}'`, path: `${path}.label` };
    seen.add(label);
  }
  return undefined;
}

const displacementLabel = (constraint: { readonly label?: string | undefined; readonly component: string }, index: number): string =>
  constraint.label ?? `${constraint.component}-${index + 1}`;

/** `TopologyObjective` from validated input; `unit` is the compliance unit of the analysis (force x length). */
export function toObjective(input: ObjectiveInput, unit: string): TopologyObjective {
  const loadCaseWeights = input.loadCaseWeights ?? {};
  if (input.kind !== 'min_volume') return { kind: 'min_compliance', loadCaseWeights };
  const displacementConstraints: TopologyDisplacementConstraint[] = (input.displacementConstraints ?? []).map((constraint, index) => ({
    label: displacementLabel(constraint, index),
    target: toTarget(constraint.target),
    component: constraint.component,
    maxDisplacement: constraint.maxDisplacement,
    ...(constraint.loadCase === undefined ? {} : { loadCase: constraint.loadCase }),
  }));
  return {
    kind: 'min_volume',
    maxCompliance: input.maxCompliance,
    unit,
    loadCaseWeights,
    ...(displacementConstraints.length === 0 ? {} : { displacementConstraints }),
  };
}
